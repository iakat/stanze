/*
 * Browser entry points.
 *
 * The reference build links a `main` and runs under WASI. A wasm module for
 * a web page instead wants a reactor: no _start, functions the host calls.
 * fe_run() takes two pointers, and a JS caller cannot make one, so this file
 * owns a fixed input and output frame and the host copies into and out of
 * them. The engine keeps its state in globals, so one instance is one
 * stream.
 */
#include "fe.h"

static float g_web_in[FE_FRAME_SIZE];
static float g_web_out[FE_FRAME_SIZE];

float *fe_web_in(void)    { return g_web_in; }
float *fe_web_out(void)   { return g_web_out; }
int    fe_web_frame(void) { return FE_FRAME_SIZE; }

void fe_web_run(void) {
    fe_run(g_web_in, g_web_out);
}
