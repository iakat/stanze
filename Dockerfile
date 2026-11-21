# Multi stage build of a one binary image. The final stage is scratch: the
# server is static (CGO off) and carries the packed client, so it needs no
# shell, no libc, no CA store and no files besides itself.
#
# The toolchain is pinned to the patch release the tree is built and tested
# with; go.mod asks for 1.27.0 and this is the 1.27.x the image ships.
ARG GO_VERSION=1.27.4
# x86-64 baseline by default. --build-arg GOAMD64=v4 emits an image that needs
# AVX-512 (x86-64-v4), which is a different tag, never a replacement.
ARG GOAMD64=v1

# Modules are their own layer, so a source change does not refetch them.
# GOTOOLCHAIN=local keeps the pin above: no toolchain download mid build.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS mods
ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=mod \
    GOTOOLCHAIN=local \
    GOPATH=/go \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/go/cache
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

# The client is platform independent, so it is built once in its own stage:
# build static/pq.wasm from source, then pack static/ into packed/static.tgz,
# which the server embeds. Both steps mirror build.sh and write no timestamps,
# so the same commit gives the same archive.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS client
ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=mod \
    GOTOOLCHAIN=local \
    GOPATH=/go \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/go/cache
WORKDIR /src
COPY --from=mods /go/pkg/mod /go/pkg/mod
COPY . .
RUN GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags "-s -w" -o static/pq.wasm ./cmd/pqwasm
RUN go run -trimpath -buildvcs=false ./cmd/pack

# The server is the only target dependent step: trimmed, stripped, no VCS
# stamp, so the same source and toolchain give the same bytes on every host.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS server
ARG TARGETOS
ARG TARGETARCH
ARG GOAMD64
ENV CGO_ENABLED=0 \
    GOFLAGS=-mod=mod \
    GOTOOLCHAIN=local \
    GOPATH=/go \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/go/cache
WORKDIR /src
COPY --from=mods /go/pkg/mod /go/pkg/mod
COPY . .
# The embedded client is the packed archive, never the loose files.
COPY --from=client /src/packed/static.tgz packed/static.tgz
RUN GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOAMD64=${GOAMD64} \
    go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/rooms .

FROM scratch
# Only the binary: the client, the queue and the done list are embedded.
COPY --from=server /out/rooms /rooms
# scratch has no /etc/passwd, so nobody is named by number. It matches the
# runAsUser of the deployment and holds no privileges the binary could use.
USER 65534:65534
# Documentation only. TURN needs its UDP port and its relay range published at
# run time (-turn-port, -turn-min-port, -turn-max-port); EXPOSE cannot describe
# a UDP range, and publishing is a run time decision anyway.
EXPOSE 8095
ENTRYPOINT ["/rooms"]
