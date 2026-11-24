/*
 * Browser entry points.
 *
 * The reference build links a `main` and runs under WASI. A wasm module for a
 * web page instead wants a reactor: no _start, functions the host calls.
 * fe_run() already takes two pointers and a JS caller can make those from
 * malloc, so the only thing missing is the frame size. The engine keeps its
 * state in globals, so one instance is one stream.
 */
#include "fe.h"

int fe_web_frame(void) { return FE_FRAME_SIZE; }
