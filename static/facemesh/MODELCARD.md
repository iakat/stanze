---
license: apache-2.0
library_name: mediapipe
pipeline_tag: keypoint-detection
tags:
- mediapipe
- litert
- tflite
- keypoint-detection
- on-device
- android
- ios
- web
- python
- flutter
- face-landmarks
- face-mesh
- blendshapes
- blazeface
- fp16
- arxiv:1907.05047
---

# MediaPipe Face Landmarker

Multi-stage MediaPipe facial geometry bundle (`face_landmarker.task`, 3.76 MB, FP16 weights) combining BlazeFace detection, 478-point 3D FaceMesh V2 landmarks (including 10 iris landmarks), and 52 Blendshape V2 expression coefficients for the [MediaPipe Face Landmarker (`FaceLandmarker`)](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker) task.

<div style="border: 1px solid rgba(59, 130, 246, 0.28); background-color: rgba(59, 130, 246, 0.06); border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
  <p style="margin: 0 0 6px 0;"><strong>Documentation:</strong> <a href="https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker">MediaPipe Face Landmarker Docs</a></p>
  <p style="margin: 0 0 6px 0;"><strong>Samples:</strong> <a href="https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/face_landmarker/android">Android</a> · <a href="https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/face_landmarker/ios">iOS</a> · <a href="https://colab.research.google.com/github/google-ai-edge/mediapipe-samples/blob/main/examples/face_landmarker/python/%5BMediaPipe_Python_Tasks%5D_Face_Landmarker.ipynb">Python Colab</a> · <a href="https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/tasks/face-landmarker.ts">Web</a> · <a href="https://github.com/google/flutter-mediapipe/tree/main/samples/vision/face_landmarker">Flutter</a></p>
  <p style="margin: 0;"><strong>Try live:</strong> <a href="https://google-ai-edge.github.io/mediapipe-samples-web/#/vision/face_landmarker">Web Demo</a></p>
</div>

`face_landmarker.task` bundles three neural networks plus canonical landmark geometry metadata (`geometry_pipeline_metadata_landmarks.binarypb`):

1. **`face_detector.tflite`:** BlazeFace short-range detector (`[1, 128, 128, 3]` RGB input).
2. **`face_landmarks_detector.tflite`:** FaceMesh V2 model (`[-1, 256, 256, 3]` RGB input) outputting 478 3D face/iris landmarks (`[-1, 1, 1, 1434]`), face presence probability, and `tongue_out` score.
3. **`face_blendshapes.tflite`:** MLP-Mixer network consuming 146 2D landmarks (`[1, 146, 2]`) to output 52 facial expression blendshape coefficients in `[0, 1]`.

**Mirroring note:** `*Left` and `*Right` blendshape scores refer to the **subject's** face, not the viewer (mirrored selfie frames will invert left/right blendshapes).

## Files

| File | Precision | Size | SHA-256 |
|---|---|---:|---|
| [`face_landmarker.task`](https://huggingface.co/litert-community/MediaPipe-FaceLandmarker/blob/main/face_landmarker.task) | `float16` | 3.76 MB (3,758,596 B) | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |

### Companion Files in Repo Root

| File | Role | Size | SHA-256 |
|---|---|---:|---|
| [`MediaPipe BlazeFace Model Card (Short Range).pdf`](./MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf) | Upstream Google model card (PDF) | 434.4 KB (434,425 B) | `cd335c06fc0de7807cd815a0777a697932598bcdb28fa98adaaabf847485f758` |
| [`Model Card Blendshape V2.pdf`](./Model%20Card%20Blendshape%20V2.pdf) | Upstream Google model card (PDF) | 2.32 MB (2,324,099 B) | `c8e9cf60a39998f4b341740623917590e050d1c97004e2de4568d84e026445ae` |
| [`Model Card MediaPipe Face Mesh V2.pdf`](./Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf) | Upstream Google model card (PDF) | 3.48 MB (3,476,420 B) | `c6add060f4ebfb37b2690136b6c711c7e5fcb7038baa2649ae3338b83979565a` |

### Download

```bash
pip install -U huggingface_hub
hf download litert-community/MediaPipe-FaceLandmarker face_landmarker.task --local-dir .
```

## Inputs, Outputs, and Model Specifications

### Bundle Contents (`face_landmarker.task`)

| Bundled Member | Uncompressed Size | SHA-256 (prefix) |
|---|---:|---|
| `face_detector.tflite` | 229.7 KB (229,746 B) | `b4578f35940bf5a1…` |
| `face_landmarks_detector.tflite` | 2.55 MB (2,553,590 B) | `c7d54204ce044847…` |
| `geometry_pipeline_metadata_landmarks.binarypb` | 19.4 KB (19,376 B) | `bdbcda96dfcb7da8…` |
| `face_blendshapes.tflite` | 955.3 KB (955,312 B) | `4f36dded049db18d…` |

### Sub-model `face_detector.tflite`

- Embedded `TFLITE_METADATA`: name `Short Range Face Detection` · version `1` · author `MediaPipe`

| Direction | Tensor | Shape | Type | Notes |
|---|---|---|---|---|
| Input | `input` | `[1, 128, 128, 3]` | `float32` | image — Input image to be detected — Normalization: `mean=[127.5], std=[127.5]` |
| Output | `regressors` | `[1, 896, 16]` | `float32` | raw boxes/keypoints — Undecoded face bboxes location and keypoints |
| Output | `classificators` | `[1, 896, 1]` | `float32` | scores — Scores of the detected bboxes. |

### Sub-model `face_landmarks_detector.tflite`

- Embedded `TFLITE_METADATA`: name `Face mesh detection model v2` · version `1` · author `MediaPipe`

| Direction | Tensor | Shape | Type | Notes |
|---|---|---|---|---|
| Input | `input_12` | `[-1, 256, 256, 3]` | `float32` | image — Input image to be detected — Normalization: `mean=[0.0], std=[255.0]` |
| Output | `Identity` | `[-1, 1, 1, 1434]` | `float32` | face_landmarks — Undecoded face landmarks. Each landmark contains x, y, and z coordinates |
| Output | `Identity_1` | `[-1, 1, 1, 1]` | `float32` | presence — Prersence score of the face. |
| Output | `Identity_2` | `[-1, 1]` | `float32` | tongue_out — Score of whether tongue is out of mouth. |

### Sub-model `face_blendshapes.tflite`

| Direction | Tensor | Shape | Type | Notes |
|---|---|---|---|---|
| Input | `serving_default_input_points:0` | `[1, 146, 2]` | `float32` | — |
| Output | `StatefulPartitionedCall:0` | `[52]` | `float32` | — |

## Use with MediaPipe Tasks

### Python Quickstart

```bash
pip install -U mediapipe huggingface_hub
```

```python
import mediapipe as mp
from huggingface_hub import hf_hub_download

model_path = hf_hub_download(
    repo_id="litert-community/MediaPipe-FaceLandmarker",
    filename="face_landmarker.task",
)

BaseOptions = mp.tasks.BaseOptions
FaceLandmarker = mp.tasks.vision.FaceLandmarker
FaceLandmarkerOptions = mp.tasks.vision.FaceLandmarkerOptions
VisionRunningMode = mp.tasks.vision.RunningMode

options = FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=model_path),
    running_mode=VisionRunningMode.IMAGE,
    num_faces=1,
    output_face_blendshapes=True,
)

with FaceLandmarker.create_from_options(options) as runner:
    mp_image = mp.Image.create_from_file("input.jpg")
    result = runner.detect(mp_image)
    if result.face_landmarks:
        print(f"Landmarks: {len(result.face_landmarks[0])}")
    if result.face_blendshapes:
        top = sorted(result.face_blendshapes[0], key=lambda c: c.score, reverse=True)[:3]
        print("Top blendshapes:", [(c.category_name, round(c.score, 3)) for c in top])
```

### Cross-Platform Guides & Samples

- **Task overview & options:** [Face Landmarker documentation](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker)
- **Platform setup guides:** [Python](https://developers.google.com/edge/mediapipe/solutions/setup_python) · [Web / JavaScript](https://developers.google.com/edge/mediapipe/solutions/setup_web) · [Android (Kotlin / Java)](https://developers.google.com/edge/mediapipe/solutions/setup_android) · [iOS (Swift)](https://developers.google.com/edge/mediapipe/solutions/setup_ios) · [Flutter (Dart)](https://developers.google.com/edge/mediapipe/solutions/setup_flutter)
- **Runnable sample apps:** [Web Demo](https://google-ai-edge.github.io/mediapipe-samples-web/#/vision/face_landmarker) · [Web Source](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/tasks/face-landmarker.ts) · [Android](https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/face_landmarker/android) · [iOS](https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/face_landmarker/ios) · [Python Notebook](https://colab.research.google.com/github/google-ai-edge/mediapipe-samples/blob/main/examples/face_landmarker/python/%5BMediaPipe_Python_Tasks%5D_Face_Landmarker.ipynb) · [Flutter](https://github.com/google/flutter-mediapipe/tree/main/samples/vision/face_landmarker)

## Latency Benchmarks

The MediaPipe Face Landmarker documentation does not publish a Pixel 6 latency table. Bundled model cards evaluate `BlazeFace (Short Range)` (2.94 ms Pixel 6 CPU / 7.41 ms GPU in Face Detector docs), `Face Mesh V2` accuracy, and `Blendshape V2` consistency.

## Intended Use, Limitations, and Fairness

Summarized from the three bundled upstream PDF model cards:

1. [`MediaPipe BlazeFace Model Card (Short Range).pdf`](./MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf) (June 9, 2021) — short-range (≈2 m) face detection. Across 17 UN subregions: recall **99.1%** / precision **95.1%**; gender: recall **98.4%** / precision **99.9%**; 5 Fitzpatrick groups: recall **98.1%** / precision **99.7%**.
2. [`Model Card MediaPipe Face Mesh V2.pdf`](./Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf) (September 15, 2022) — 478 3D surface & iris landmarks evaluated on 1,700 selfie images across 17 UN regions (100/region) via 2D IOD MAE (vs. 2.56% human inter-annotator discrepancy): overall **2.62%** tracking / **3.24%** reacquisition; across genders **2.61%–2.62%** tracking; across Fitzpatrick 1–6 **2.49%–2.90%** tracking.
3. [`Model Card Blendshape V2.pdf`](./Model%20Card%20Blendshape%20V2.pdf) (November 11, 2022) — 52 AR facial blendshapes evaluated on 511 multi-view lab subjects (18,199 high-activation expression items): overall Mean Absolute Deviation (MAD) **0.199** (STDEV **0.237**); gender MAD **0.196–0.203**; Monk skin tones 1–10 MAD **0.192–0.210**.

- **Out-of-scope uses:**
  - **Any form of surveillance or identity recognition is explicitly out of scope and not enabled by this technology.**
  - Predicted face landmarks and facial blendshapes **do not provide facial recognition or identification and do not store any unique face representation**.
  - Human life-critical decisions, crowd counting, or faces > 80° rotated / < 50% visible.

## Provenance

Every model binary in this repository is byte-identical (unmodified weights, metadata, and `.task` bundle archive bytes) to the official artifact served by Google from `storage.googleapis.com/mediapipe-models`.

| Repo File | Upstream URL | GCS Generation | Upstream `Last-Modified` | Pinned Bucket Version |
|---|---|---|---|---|
| `face_landmarker.task` | [`face_landmarker.task`](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task) | `1683136941468629` | Wed, 03 May 2023 18:02:21 GMT | `/1/` |

## License and Citation

- License: `apache-2.0` — Stated as Apache License, Version 2.0 in the bundled upstream Google model-card PDFs.

### Citation

```bibtex
@inproceedings{bazarevsky2019blazeface,
  title     = {BlazeFace: Sub-millisecond Neural Face Detection on Mobile GPUs},
  author    = {Bazarevsky, Valentin and Kartynnik, Yury and Vakunov, Andrey and Raveendran, Karthik and Grundmann, Matthias},
  booktitle = {CVPR Workshop on Computer Vision for Augmented and Virtual Reality},
  year      = {2019},
  url       = {https://arxiv.org/abs/1907.05047}
}
```
