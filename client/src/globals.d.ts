/*
 Globals the page loads at run time: the wasm glue of the handshake and of the
 transcriber, the test hook, and the webkit spelling of the audio context. They
 are assigned by the loader, so every one of them is optional.
*/

interface Window {
  e2eApp?: unknown;
  stanzePQ?: unknown;
  Go?: unknown;
  Vosk?: unknown;
  Module?: unknown;
  webkitAudioContext?: typeof AudioContext;
}

interface WorkerGlobalScope {
  Vosk?: unknown;
  Module?: unknown;
}

declare function importScripts(...urls: string[]): void;
