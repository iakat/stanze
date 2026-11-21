# Build and run. `make` is optional; build.sh does the same thing without it.

GO ?= go
BIN ?= bin

.PHONY: all build selftest run test clean

all: build selftest

build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w" -o $(BIN)/rooms .

selftest:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w" -o $(BIN)/selftest ./cmd/selftest

# Dev server with the relay enabled on loopback.
run: build
	TURN_SECRET=dev-secret TURN_PUBLIC_IP=127.0.0.1 $(BIN)/rooms -listen 127.0.0.1:8095

# Test a server that is already running on ADDR.
test: selftest
	$(BIN)/selftest -addr $${ADDR:-http://127.0.0.1:8095}

clean:
	rm -rf $(BIN)
