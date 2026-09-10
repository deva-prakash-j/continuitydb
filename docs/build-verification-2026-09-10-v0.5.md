# v0.5 local embedding verification — 2026-09-10

## Scope

This verification covers the built-in local semantic provider layered on the
unpublished v0.4 release commit. It does not expand the distributed scalability
claim.

## Gates

| Gate | Result |
|---|---|
| Model provenance | fixed BGE-small ONNX repository and 40-character revision |
| Artifact integrity | pinned byte sizes and SHA-256 for q8 ONNX + vocabulary |
| Cache safety | private directory/files, exclusive download lock, atomic install, offline mode |
| Runtime dependency audit | zero known npm vulnerabilities at verification time |
| Tokenization | bounded input, acronym/camel splitting, WordPiece max 512 tokens |
| Projection validity | model ID + canonical content hash; idempotent backfill |
| Quality stability | 3/3 identical runs: exact 9/9, semantic 5/5, isolation 0 |
| CLI smoke | pull/status/backfill and semantic-only retrieval pass |
| Node compatibility | full local semantic fixture passes on Node 22.20.0 and 25.9.0 |
| Unit/integration suite | 45/45 pass before final release gate |

## Performance point

On an Intel Xeon Silver 4416+ VM with one WASM thread and Node 25.9.0:

- verified-cache/session initialization: 550.001 ms;
- warm single-text p95: 23.233 ms;
- 32-text batch p95: 600.658 ms;
- 32-text batch throughput: 56.34 texts/s;
- RSS after the benchmark: 363.29 MiB.

The model and vocabulary total 34,245,934 bytes. The optional ONNX WASM npm
runtime is about 137 MB unpacked in this environment. These numbers are
published as explicit footprint/latency trade-offs, not described as free.

## Verdict

The provider closes the model-free semantic regression gap while keeping memory
text local. The 14-query fixture is too small for broad retrieval claims.
Before recommending the model for large multilingual or code-heavy corpora, run
a held-out dataset with at least hundreds of exact, conceptual, dependency,
stale/conflict, and adversarial isolation queries.
