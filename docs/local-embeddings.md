# Built-in local embeddings

ContinuityDB can run semantic retrieval without an API account or sending
memory text off-host.

## Model and runtime

| Property | Value |
|---|---|
| Upstream model | `BAAI/bge-small-en-v1.5` |
| ONNX repository | `Xenova/bge-small-en-v1.5` |
| Pinned revision | `ea104dacec62c0de699686887e3f920caeb4f3e3` |
| License | MIT |
| Quantization | q8 ONNX |
| Dimensions | 384 |
| Model + vocabulary | 34,245,934 bytes |
| Inference runtime | optional `onnxruntime-web` WASM |

Model weights are not copied into the npm tarball. `embeddings-pull` downloads
the two required artifacts from fixed HTTPS URLs, enforces a 40 MiB per-file
limit, verifies pinned byte sizes and SHA-256 digests, and atomically moves them
into a private cache. A process verifies a cache before first use and then reuses
that verified model for the process lifetime.

## Setup

```bash
continuitydb embeddings-pull --home /absolute/private/path/continuitydb-data

CONTINUITYDB_EMBEDDING_PROVIDER=local \
CONTINUITYDB_LOCAL_MODEL_OFFLINE=true \
continuitydb embeddings-index --home /absolute/private/path/continuitydb-data
```

Run the HTTP or MCP service with the same provider and cache configuration.
Newly activated memories are indexed automatically. `embeddings-index` is an
idempotent backfill for active records that do not have a current content-hash
projection.

## Retrieval behavior

Documents use normalized mean-pooled embeddings. Queries use BGE's recommended
retrieval prefix. Code identifiers are split at acronym/camel-case boundaries
before WordPiece tokenization. Input is capped before tokenization and the model
sequence is capped at 512 tokens.

The semantic index is derived state. Every row carries the model ID and
canonical content hash, so a changed record or different model cannot silently
reuse an old vector. Tenant, owner, project, sensitivity, branch, time, expiry,
and stale-state filters are applied before candidates can be returned.

## Measured local evidence

On the repository's 14-query regression fixture, three consecutive runs each
produced:

- exact Recall@5: **9/9**;
- semantic Recall@5: **5/5**;
- semantic MRR@5: **0.55**;
- isolation violations: **0**.

On the 2026-09-10 test VM (`Intel Xeon Silver 4416+`, one WASM thread, Node
25.9.0), verified-cache initialization took 550 ms, single-text warm p95 was
23.233 ms, 32-item batch p95 was 600.658 ms, batch throughput was 56.34
texts/second, and process RSS after the suite was 363.29 MiB. These numbers are
machine-specific and do not prove distributed retrieval quality or scale.

Reproduce with:

```bash
npm run benchmark:local
npm run benchmark:local:performance -- --repetitions=10
```

## Security and operations

- Local mode never sends memory/query text to Hugging Face; only model artifact
  GET requests occur during an explicit pull or uncached first use.
- Use `CONTINUITYDB_LOCAL_MODEL_OFFLINE=true` after prefetching for a closed
  network runtime.
- The model cache is derived and recoverable. Back up canonical records, not
  vectors or downloaded weights.
- A model file is still executable parser input to ONNX Runtime. ContinuityDB
  reduces supply-chain drift with fixed revisions, sizes, hashes, and runtime
  versions; operators should retain normal dependency and artifact scanning.
- Embedded semantic retrieval remains a bounded exact vector scan. Large team
  deployments need a filter-first ANN adapter rather than scanning local blobs.
