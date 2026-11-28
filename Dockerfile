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

# The incoming filter is one compile per tier of one engine tree, so it is its
# own stage: a Debian base carrying the upstream wasi-sdk, because the filter
# must be compiled by a clang that owns a wasm32-wasip1 sysroot and its
# builtins. Debian's own clang has neither (no wasm headers, no wasm builtins
# archive), and Alpine's clang has no compiler at all, so neither can build it.
# The weights follow the tier, because fe.q8 in the engine tree and the frame
# size the worklet cuts are one property.
#
# The tier is an ARG of this stage and not of the file. An ARG declared before a
# FROM is in scope for the FROM lines only, so one written above this stage
# would leave FE_TIER empty here, build.sh would fall back to its own default
# (medium, 320 samples), and the image would ship a module that fe_init refuses
# beside the small weights. GOAMD64 above is read the same way and is likewise
# re-declared in the stage that consumes it.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS werecompiler
ARG FE_TIER=small
# nodejs is here for the check below: the pairing test runs the module the way
# the page does, in V8, so a wrong pair fails this stage instead of a browser.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl nodejs \
 && rm -rf /var/lib/apt/lists/*
# Pinned by the exact release URL and by the sha256 of the tarball, so a
# changed download fails the build instead of changing the module silently.
# Both values are written straight into the RUN: a build argument is expanded
# by the frontend as a make-style variable, so an underscore in the path gets
# eaten and curl exits 3 on a malformed URL. The release tag (wasi-sdk-34)
# and the version (34.0) do not share a spelling, hence one spelled path.
# The tarball is 190 MB and a runner transfer can drop, so curl retries
# instead of restarting the stage over one lost connection.
RUN cd /opt \
 && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 \
      --connect-timeout 20 --max-time 900 -o sdk.tar.gz \
      https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz \
 && echo "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4  sdk.tar.gz" | sha256sum -c - \
 && test -s sdk.tar.gz \
 && mkdir -p wasi-sdk \
 && tar -xzf sdk.tar.gz -C wasi-sdk --strip-components=1 \
 && rm sdk.tar.gz
ENV PATH=/opt/wasi-sdk/bin:$PATH
WORKDIR /src
COPY tools/fewasm ./tools/fewasm
# The check and the two client files it reads: it evaluates the worklet's own
# loader over the pair, so it must read the worker and the worklet of this
# commit, not a copy.
COPY tools/fe-check.mjs ./tools/fe-check.mjs
COPY static/fastenhancer-worker.js static/fastenhancer-worklet.js ./static/
# The check is the point of the step: a page that asks for /fe.wasm and gets
# nothing has no incoming filter at all, and a module of the wrong tier is the
# same loss with no missing file to notice, so the pair is exercised here. The
# sandbox build takes its clang from PATH, and the strip step comes from the
# same directory as the compiler.
#
# The pair is assembled first and checked where it lies, so the bytes the check
# accepts are the bytes the next stage copies. FE_TIER goes to the check as well
# as to the build: the checker refuses an empty tier (what an out of scope ARG
# gives) and a bake whose own fe.tier disagrees with it, so a tier that never
# reached the compiler fails here instead of shipping a medium module beside the
# small weights. The hashes are what the client stage verifies after its COPY.
RUN set -eu; \
    TIER="$FE_TIER" tools/fewasm/build.sh /fe/build; \
    mkdir -p /fe; \
    cp /fe/build/fe.wasm /fe/fe.wasm; \
    cp /fe/build/fe.tier /fe/fe.tier; \
    cp tools/fewasm/engine/weights/fe.q8 /fe/fe.q8; \
    FE_TIER="$FE_TIER" \
    FE_MODULE=/fe/fe.wasm \
    FE_WEIGHTS=/fe/fe.q8 \
    FE_TIER_FILE=/fe/fe.tier \
    FE_WORKLET=static/fastenhancer-worklet.js \
      node tools/fe-check.mjs; \
    cd /fe; \
    sha256sum fe.wasm fe.q8 > SHA256

# The client is platform independent, so it is built once in its own stage:
# build static/pq.wasm from source, then pack static/ into packed/static.tgz,
# which the server embeds. Both steps mirror build.sh and write no timestamps,
# so the same commit gives the same archive.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS client
# The commit the image was built from, shown on the page. Pass it with
# --build-arg GIT_COMMIT=$(git rev-parse --short HEAD); it defaults to unknown.
ARG GIT_COMMIT=unknown
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
# The filter came from the stage above, never from the tree: it is a build
# artifact, so a context without one (a clean clone, a CI checkout without the
# local toolchain) still gives a complete image.
COPY --from=werecompiler /fe/fe.wasm static/fe.wasm
COPY --from=werecompiler /fe/fe.q8 static/fe.q8
COPY --from=werecompiler /fe/SHA256 /fe/SHA256
RUN printf '%s\n' "${GIT_COMMIT}" > static/version.txt
# Nothing below may ship a page whose filter files are missing, empty, or not
# the pair the werecompiler stage checked: a COPY from the wrong path is a wrong
# tier again, and the packer would happily pack whatever is in static/.
RUN cd static && sha256sum -c /fe/SHA256 && test -s fe.wasm && test -s fe.q8
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
