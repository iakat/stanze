#!/bin/sh
# Build the server and the self test without needing a system Go install.
# Set GO to an existing go binary to override the bundled toolchain path.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

if [ -z "${GO:-}" ]; then
	if [ -x "$here/../tools/go/bin/go" ]; then
		GO="$here/../tools/go/bin/go"
	elif command -v go >/dev/null 2>&1; then
		GO=$(command -v go)
	else
		echo "no go toolchain found; set GO=/path/to/go" >&2
		exit 1
	fi
fi

export GOFLAGS="${GOFLAGS:--mod=readonly}"
export CGO_ENABLED=0
[ -n "${GOPATH:-}" ] || export GOPATH="$(cd "$here/.." && pwd)/tools/gopath"
[ -n "${GOMODCACHE:-}" ] || export GOMODCACHE="$GOPATH/pkg/mod"
[ -n "${GOCACHE:-}" ] || export GOCACHE="$(cd "$here/.." && pwd)/tools/gocache"

# The key agreement half of the client is Go built to WebAssembly. It is a
# build artifact now, so it is not in git; build it before the packer reads
# static/.
GOOS=js GOARCH=wasm "$GO" build -trimpath -ldflags "-s -w" -o static/pq.wasm ./cmd/pqwasm

# The packing filter is a build artifact too. Its own builder needs a clang
# with the wasm32-wasip1 target; ../tools/wasi-sdk carries one. A tree that
# already has the module keeps it unless FE_REBUILD=1.
#
# The tier is a property of the weights and of the frame size the worklet
# cuts, so both come from one variable: the incoming streams run Small now.
FE_TIER="${FE_TIER:-small}"
# A module older than the engine source or the tier is from another bake, and
# shipping it would pair new weights with an old engine. mtime is the cheap
# test; the engine tree is small.
FE_STALE=0
if [ -s static/fe.wasm ]; then
	if [ -n "$(find "$here/tools/fewasm/engine" "$here/tools/fewasm/build.sh" -newer "$here/static/fe.wasm" -print -quit 2>/dev/null)" ]; then
		FE_STALE=1
	fi
fi
if [ ! -s static/fe.wasm ] || [ "$FE_STALE" = "1" ] || [ "${FE_REBUILD:-0}" = "1" ]; then
	FE_CC="${FE_CC:-$here/../tools/wasi-sdk/bin/clang}"
	if [ ! -x "$FE_CC" ]; then
		echo "no wasm clang for the filter; set FE_CC=/path/to/clang" >&2
		exit 1
	fi
	TIER="$FE_TIER" CC="$FE_CC" "$here/tools/fewasm/build.sh" "$here/tools/fewasm/out" >/dev/null
	cp "$here/tools/fewasm/out/fe.wasm" static/fe.wasm
	cp "$here/tools/fewasm/engine/weights/fe.q8" static/fe.q8
	# The builder leaves the debug and name sections in; the page never reads
	# them and they double the module.
	FE_STRIP="$(dirname "$FE_CC")/llvm-strip"
	[ -x "$FE_STRIP" ] && "$FE_STRIP" --strip-all static/fe.wasm
	# The pair is checked before it is packed, and against the tier that was
	# asked for: the module and fe.q8 only work together, and a mismatch is
	# one line in a corner of a page and nothing anywhere else. FE_TIER_FILE
	# points at the bake's own record, which is removed with the rest of out/.
	if command -v node >/dev/null 2>&1; then
		FE_TIER="$FE_TIER" FE_TIER_FILE="$here/tools/fewasm/out/fe.tier" \
			node "$here/tools/fe-check.mjs" || exit 1
	fi
	rm -rf "$here/tools/fewasm/out"
fi

# The client is TypeScript under client/, and the bundle it produces is what the
# page loads. Node and one `npm --prefix client install` are needed for this
# step; a tree that already carries a built static/app.js can skip it with
# SKIP_CLIENT=1.
if [ "${SKIP_CLIENT:-0}" != "1" ]; then
	if [ ! -x "$here/client/node_modules/.bin/esbuild" ]; then
		echo "client dependencies are missing; run: npm --prefix client install" >&2
		exit 1
	fi
	if [ -z "${NODE:-}" ]; then
		if [ -x "$here/../node/bin/node" ]; then
			NODE="$here/../node/bin/node"
		else
			NODE=$(command -v node || true)
		fi
	fi
	if [ -z "$NODE" ]; then
		echo "no node found; set NODE=/path/to/node" >&2
		exit 1
	fi
	( cd "$here" && "$NODE" client/build.mjs )
fi

# The client is embedded as one gzip compressed tar, so it is packed first.
# The packer writes sorted names and no timestamps, so the archive is the same
# for the same files and two builds of one commit match.
if [ ! -s "$here/static/app.js" ]; then
	echo "static/app.js is missing; build the client first (drop SKIP_CLIENT)" >&2
	exit 1
fi
# The commit the page reports. GIT_COMMIT overrides; a tree with no git
# history (a release tarball) writes unknown and the label stays hidden.
printf '%s\n' "${GIT_COMMIT:-$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)}" > "$here/static/version.txt"
"$GO" run ./cmd/pack

mkdir -p bin
"$GO" build -trimpath -buildvcs=false -ldflags "-s -w" -o bin/stanze .
"$GO" build -trimpath -buildvcs=false -ldflags "-s -w" -o bin/selftest ./cmd/selftest
ls -l bin
