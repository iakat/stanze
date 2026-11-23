# Build and run. `make` is optional; build.sh does the same thing without it.

GO ?= go
BIN ?= bin
NODE ?= /data/workspace/node/bin
PW ?=
ROOMSBASE ?= http://127.0.0.1:8095

.PHONY: all build client selftest run test typecheck lint deps smoke sealed check clean

all: build selftest

build: client
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "-s -w" -o $(BIN)/stanze .

# One bundle from the TypeScript tree. The page loads static/app.js.
client:
	$(NODE)/node client/build.mjs

selftest:
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "-s -w" -o $(BIN)/selftest ./cmd/selftest

# Dev server with the relay enabled on loopback.
run: build
	TURN_SECRET=dev-secret TURN_PUBLIC_IP=127.0.0.1 $(BIN)/stanze -listen 127.0.0.1:8095

# Test a server that is already running on ADDR.
test: selftest
	$(BIN)/selftest -addr $${ADDR:-http://127.0.0.1:8095}

# Type check the client source.
typecheck:
	PATH=$(NODE):$$PATH client/node_modules/.bin/tsc -p client/tsconfig.json

lint:
	PATH=$(NODE):$$PATH client/node_modules/.bin/eslint client

# Report dev dependencies that are behind the registry. Versions in
# client/package.json are exact and take the update from this output.
deps:
	PATH=$(NODE):$$PATH npm --prefix client outdated || true

# One real browser, one real join. Fails on the first uncaught exception.
smoke:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) $(NODE)/node tools/smoke.js

# Two browsers in a sealed room: handshake, media frames, sealed chat, audit.
sealed:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/pq-browser-e2e.js

# Two browsers, one room, the passphrase changed mid call.
gate:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/gate-e2e.js

# What a normal check runs: the types first, then the browser.
check: typecheck lint smoke

clean:
	rm -rf $(BIN) packed/static.tgz
