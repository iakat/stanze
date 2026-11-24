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
    GOTOOLCHAIN=local \
    GOPATH=/go \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/go/cache
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

# The TypeScript client is bundled by esbuild into static/app.js; that needs
# Node and the locked dev dependencies, so it happens in its own stage. The Go
# stage below only consumes the bundle.
FROM --platform=$BUILDPLATFORM node:22-alpine AS clientbundle
WORKDIR /src
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client
COPY client ./client
RUN node client/build.mjs

# The client is platform independent, so it is built once in its own stage:
# build static/pq.wasm from source, then pack static/ into packed/static.tgz,
# which the server embeds. Both steps mirror build.sh and write no timestamps,
# so the same commit gives the same archive.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS client
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOPATH=/go \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/go/cache
WORKDIR /src
COPY --from=mods /go/pkg/mod /go/pkg/mod
COPY . .
COPY --from=clientbundle /src/static/app.js static/app.js
RUN GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags "-s -w" -o static/pq.wasm ./cmd/pqwasm
RUN go run -trimpath -buildvcs=false ./cmd/pack

# The server is the only target dependent step: trimmed, stripped, no VCS
# stamp, so the same source and toolchain give the same bytes on every host.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS server
ARG TARGETOS
ARG TARGETARCH
ARG GOAMD64
ENV CGO_ENABLED=0 \
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
    go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/stanze .

# Optional in-browser transcription files. Left at their empty default the
# stage makes an empty /vosk and the image is still the one binary above. Given
# VOSK_MODEL_URL (and VOSK_MODEL_SHA256, recommended) the stage fetches the
# library and one model with the repo's own script, and the image carries them,
# so the server runs with -vosk-dir /vosk and needs no host files at all.
# VOSK_MODEL_LANG is the label of that model, en by default; a second language
# is a second build, or a directory of models mounted over /vosk.
ARG VOSK_MODEL_URL=
ARG VOSK_MODEL_SHA256=
ARG VOSK_MODEL_LANG=en
FROM --platform=$BUILDPLATFORM alpine:3.20 AS vosk
ARG VOSK_MODEL_URL
ARG VOSK_MODEL_SHA256
ARG VOSK_MODEL_LANG
COPY tools/fetch-vosk.sh /fetch-vosk.sh
RUN if [ -n "$VOSK_MODEL_URL" ]; then \
	apk add --no-cache curl && \
	MODEL_URL="$VOSK_MODEL_URL" MODEL_SHA256="$VOSK_MODEL_SHA256" LANG="$VOSK_MODEL_LANG" sh /fetch-vosk.sh /vosk; \
	else \
	mkdir -p /vosk; \
	fi
# The multilingual engine is never built into the image: its one model is
# 348 MB and the rest of its bundle is a download of its own, so the stage only
# makes an empty /omni and an operator mounts the directory there (or runs with
# -omni-dir pointing at it). Empty means the engine is not offered.
RUN mkdir -p /omni

FROM scratch
# Only the binary: the client, the queue and the done list are embedded.
COPY --from=server /out/stanze /stanze
# The transcription directory is empty unless the build asked for a model; the
# server offers the feature only when the library and a model are there.
COPY --from=vosk /vosk /vosk
ENV VOSK_DIR=/vosk
# The multilingual directory holds nothing in this image on purpose; mount a
# bundle over /omni (or pass -omni-dir) to offer that engine as well.
COPY --from=vosk /omni /omni
ENV OMNI_DIR=/omni
# scratch has no /etc/passwd, so nobody is named by number. It matches the
# runAsUser of the deployment and holds no privileges the binary could use.
USER 65534:65534
# Documentation only. TURN needs its UDP port and its relay range published at
# run time (-turn-port, -turn-min-port, -turn-max-port); EXPOSE cannot describe
# a UDP range, and publishing is a run time decision anyway.
EXPOSE 8095
ENTRYPOINT ["/stanze"]
