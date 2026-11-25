#!/usr/bin/env python3
"""fp32 ONNX reference on the wasm engine's analysis grid.

Reads a raw mono f32 file, runs the spec2spec ONNX model one frame at a
time over the same causal STFT grid the C engine uses (frame t =
padded[t*hop : t*hop + 1024], periodic Hann, left history of 1024-hop
zeros), then writes the raw f32 output of the same length.

    PYTHONPATH=/data/workspace/tools/pylib313 python3 ref_onnx.py \
        <in.f32> <model.onnx> <out.f32> [frames] [hop]

The hop defaults to 320 (Medium). The b and s tiers use 512.

The compression (spec *= mag^(0.3-1)) is inside the spec2spec graph, so
only the STFT framing lives here.
"""
import sys

import numpy as np
import onnxruntime as ort

SR = 48000
N_FFT = 1024


def synthesis_window(hop):
    n = np.arange(N_FFT)
    w = 0.5 - 0.5 * np.cos(2.0 * np.pi * n / N_FFT)      # periodic Hann
    K = (N_FFT + hop - 1) // hop
    num_frames = 2 * K - 1
    fold = np.zeros(num_frames * hop + N_FFT)
    for f in range(num_frames):
        fold[f * hop: f * hop + N_FFT] += w * w
    win_sq_sum = fold[(K - 1) * hop: (K - 1) * hop + N_FFT]
    return w, w / win_sq_sum


def main(in_f32, onnx_path, out_f32, num_frames=None, hop=320):
    audio = np.clip(np.fromfile(in_f32, dtype=np.float32).astype(np.float64),
                    -1.0, 1.0)

    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    sess = ort.InferenceSession(onnx_path, sess_options=so,
                                providers=['CPUExecutionProvider'])

    ins = {i.name: i for i in sess.get_inputs()}
    cache_names = [n for n in ins if n.startswith('cache_in_')]
    cache_len = N_FFT - hop

    T = len(audio) // hop
    if num_frames is not None:
        T = min(T, int(num_frames))
    print(f"hop {hop}, cache {cache_len}, {T} frames", flush=True)

    padded = np.concatenate([np.zeros(cache_len), audio])
    need = (T - 1) * hop + N_FFT
    if len(padded) < need:
        padded = np.concatenate([padded, np.zeros(need - len(padded))])

    w_ana, w_syn = synthesis_window(hop)

    caches = {}
    for n in cache_names:
        shape = [d if isinstance(d, int) else 1 for d in ins[n].shape]
        caches[n] = np.zeros(shape, dtype=np.float32)

    ola = np.zeros(T * hop + N_FFT)
    for t in range(T):
        frame = padded[t * hop: t * hop + N_FFT] * w_ana
        spec = np.fft.rfft(frame)
        spec_in = np.stack([spec.real, spec.imag], axis=-1)
        spec_in = spec_in.reshape(1, N_FFT // 2 + 1, 1, 2).astype(np.float32)
        feed = {'spec_in': spec_in}
        feed.update(caches)
        outs = sess.run(None, feed)
        for j, n in enumerate(cache_names):
            caches[n] = outs[j + 1]
        rec = np.fft.irfft(
            outs[0].reshape(N_FFT // 2 + 1, 2)[:, 0]
            + 1j * outs[0].reshape(N_FFT // 2 + 1, 2)[:, 1], n=N_FFT)
        ola[t * hop: t * hop + N_FFT] += rec * w_syn
        if (t + 1) % 200 == 0:
            print(f"  {t + 1}/{T}", flush=True)

    out = np.clip(ola[: T * hop], -1.0, 1.0).astype(np.float32)
    out.tofile(out_f32)
    print(f"wrote {out_f32}: {out.size} samples")


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3],
         sys.argv[4] if len(sys.argv) > 4 else None,
         int(sys.argv[5]) if len(sys.argv) > 5 else 320)
