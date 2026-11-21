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

export GOFLAGS="${GOFLAGS:--mod=mod}"
export CGO_ENABLED=0
[ -n "${GOPATH:-}" ] || export GOPATH="$(cd "$here/.." && pwd)/tools/gopath"
[ -n "${GOMODCACHE:-}" ] || export GOMODCACHE="$GOPATH/pkg/mod"
[ -n "${GOCACHE:-}" ] || export GOCACHE="$(cd "$here/.." && pwd)/tools/gocache"

mkdir -p bin
"$GO" build -trimpath -ldflags "-s -w" -o bin/rooms .
"$GO" build -trimpath -ldflags "-s -w" -o bin/selftest ./cmd/selftest
ls -l bin
