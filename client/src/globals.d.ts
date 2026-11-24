/*
 Globals the loader sets at run time: wasm glue, the transcriber, the test hook
 and the webkit audio context. All optional.
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
