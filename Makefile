# Build and run. `make` is optional; build.sh does the same thing without it.

GO ?= go
BIN ?= bin
NODE ?= /data/workspace/node/bin
TSC ?= /data/workspace/tools/tscheck/node_modules/.bin/tsc
PW ?=
ROOMSBASE ?= http://127.0.0.1:8095

.PHONY: all build selftest run test typecheck smoke sealed check clean

all: build selftest

build:
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "-s -w" -o $(BIN)/stanze .

selftest:
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "-s -w" -o $(BIN)/selftest ./cmd/selftest

# Dev server with the relay enabled on loopback.
run: build
	TURN_SECRET=dev-secret TURN_PUBLIC_IP=127.0.0.1 $(BIN)/stanze -listen 127.0.0.1:8095

# Test a server that is already running on ADDR.
test: selftest
	$(BIN)/selftest -addr $${ADDR:-http://127.0.0.1:8095}

# Type check the client as JavaScript (no build step, no emit).
typecheck:
	PATH=$(NODE):$$PATH $(TSC) -p .

# One real browser, one real join. Fails on the first uncaught exception.
smoke:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) $(NODE)/node tools/smoke.js

# Two browsers in a sealed room: handshake, media frames, sealed chat, audit.
sealed:
	@test -n "$(PW)" || { echo "set PW to the playwright-core directory (see README)"; exit 1; }
	PATH=$(NODE):$$PATH PW=$(PW) ROOMSBASE=$(ROOMSBASE) OUTDIR=$(OUTDIR) $(NODE)/node tools/pq-browser-e2e.js

# What a normal check runs: the types first, then the browser.
check: typecheck smoke

clean:
	rm -rf $(BIN) packed/static.tgz
