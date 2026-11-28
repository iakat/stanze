# Build and run. `make` is optional; build.sh does the same thing without it.

GO ?= go
BIN ?= bin
NODE ?= /data/workspace/node/bin
PW ?=
ROOMSBASE ?= http://127.0.0.1:8095

.PHONY: all build client wasm selftest run test typecheck lint deps format readme readme-check smoke tabmute sealed wam gate world door check clean

all: build selftest

build: client wasm
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "-s -w" -o $(BIN)/stanze .

# One bundle from the TypeScript tree. The page loads static/app.js.
client:
	$(NODE)/node client/build.mjs

# The key agreement half of the client, Go built to WebAssembly. The page
# loads static/pq.wasm. It is a build artifact and is not in git.
wasm:
	CGO_ENABLED=0 GOOS=js GOARCH=wasm $(GO) build -trimpath -ldflags "-s -w" -o static/pq.wasm ./cmd/pqwasm

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

# Refresh the line counts in client/README.md; a module that is missing from
# the table is named and the target fails.
readme:
	PATH=$(NODE):$$PATH $(NODE)/node client/tools/overview.mjs --write

# Fail if a count is stale or a module has no row yet. Runs in `check`.
readme-check:
	PATH=$(NODE):$$PATH $(NODE)/node client/tools/overview.mjs --check

# Report dev dependencies that are behind the registry. Versions in
# client/package.json are exact and take the update from this output.
deps:
	PATH=$(NODE):$$PATH npm --prefix client outdated || true

format:
	PATH=$(NODE):$$PATH client/node_modules/.bin/prettier --write "client/src/**/*.ts" client/build.mjs client/eslint.config.mjs

# One real browser, one real join. Fails on the first uncaught exception.
smoke:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) $(NODE)/node tools/smoke.js

# Two browsers in one room, and the microphone on a hidden tab: the gain, the
# button, the peer's view and the return, which the smoke of one page can not see.
tabmute:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) $(NODE)/node tools/tabmute-e2e.js

# Two browsers in a sealed room: handshake, media frames, sealed chat, audit.
sealed:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/pq-browser-e2e.js

# One browser, a room saved as a .wam world: the tmj it names is drawn.
wam:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/wam-e2e.js

# Two browsers, one room, the passphrase changed mid call.
gate:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/gate-e2e.js

# Two browsers on one map: the world contract, case by case.
world:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) WORLD_ROOM=$(WORLD_ROOM) $(NODE)/node tools/world-e2e.js

# A door carries a guest to another room and lands them on its start area.
door:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/door-e2e.js

# What a normal check runs: the types, the lint, the readme table, then the
# browser.
check: typecheck lint readme-check smoke

clean:
	rm -rf $(BIN) packed/static.tgz
