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
printf '%s\n' "${GIT_COMMIT:-unknown}" > "$here/static/version.txt"
"$GO" run ./cmd/pack

mkdir -p bin
"$GO" build -trimpath -buildvcs=false -ldflags "-s -w" -o bin/stanze .
"$GO" build -trimpath -buildvcs=false -ldflags "-s -w" -o bin/selftest ./cmd/selftest
ls -l bin
