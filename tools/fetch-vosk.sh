#!/bin/sh
# Fetch the library and one model of the optional in-browser transcription
# into one directory, for the server flag -vosk-dir (or VOSK_DIR). Nothing here
# is part of the binary or of the repository, and the server offers the feature
# only when the library and at least one model are present.
#
#   tools/fetch-vosk.sh /srv/stanze-vosk
#   stanze -vosk-dir /srv/stanze-vosk
#
# vosk.js   the vosk-browser library 0.0.8 (Apache-2.0), from the npm registry,
#           checked against the pinned sha256 below.
# model     one vosk model as a tar.gz that vosk-browser can load, saved as
#           model-<LANG>.tar.gz. The model is not pinned in this script: give
#           the URL in MODEL_URL, the label in LANG (en by default, it for
#           Italian) and the sha256 you expect in MODEL_SHA256 (without it the
#           script prints the hash and you decide). Run the script again with
#           another LANG to offer a second language; the page then shows a
#           picker.
set -eu

dir="${1:?usage: fetch-vosk.sh DIR}"
: "${MODEL_URL:?set MODEL_URL to the model tar.gz (a vosk small model)}"
lang="${LANG:-en}"
case "$lang" in
	[a-z][a-z]|[a-z][a-z][a-z]) ;;
	*) echo "LANG must be a short label like en or it, not $lang" >&2; exit 1 ;;
esac
LIB_SHA256="${LIB_SHA256:-29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c}"

mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "library: vosk-browser 0.0.8"
curl -fsSL -o "$tmp/vosk.tgz" https://registry.npmjs.org/vosk-browser/-/vosk-browser-0.0.8.tgz
tar -xzf "$tmp/vosk.tgz" -C "$tmp" package/dist/vosk.js
got="$(sha256sum "$tmp/package/dist/vosk.js" | cut -d' ' -f1)"
if [ "$got" != "$LIB_SHA256" ]; then
	echo "vosk.js sha256 is $got, expected $LIB_SHA256" >&2
	exit 1
fi
cp "$tmp/package/dist/vosk.js" "$dir/vosk.js"

echo "model: $MODEL_URL"
curl -fsSL -o "$tmp/model.tar.gz" "$MODEL_URL"
mgot="$(sha256sum "$tmp/model.tar.gz" | cut -d' ' -f1)"
if [ -n "${MODEL_SHA256:-}" ] && [ "$mgot" != "$MODEL_SHA256" ]; then
	echo "model sha256 is $mgot, expected $MODEL_SHA256" >&2
	exit 1
fi
[ -n "${MODEL_SHA256:-}" ] || echo "model sha256 (not pinned): $mgot"
cp "$tmp/model.tar.gz" "$dir/model-$lang.tar.gz"
echo "done: $dir/model-$lang.tar.gz"
