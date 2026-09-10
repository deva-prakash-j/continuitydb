# Third-party notices

ContinuityDB is Apache-2.0 licensed. Optional local semantic retrieval uses the
following separately licensed components and artifacts:

## BGE small English v1.5

- Upstream: <https://huggingface.co/BAAI/bge-small-en-v1.5>
- ONNX conversion: <https://huggingface.co/Xenova/bge-small-en-v1.5>
- License: MIT
- ContinuityDB downloads a pinned quantized ONNX artifact and vocabulary on
  demand; model weights are not part of the ContinuityDB npm tarball.

## ONNX Runtime Web

- Project: <https://github.com/microsoft/onnxruntime>
- Package: `onnxruntime-web`
- License: MIT

The corresponding license texts and notices remain available from the linked
upstream projects and installed packages.
