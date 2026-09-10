# Changelog

All notable changes are documented here. The project follows Semantic Versioning
after the first stable release.

## [Unreleased]

- Added compare-and-set handoff lineage with `previous_checkpoint_id`; stale or
  concurrent successors are quarantined and accepted successors supersede the
  prior active checkpoint.
- Made handoff quota checks, lineage validation, sequence allocation,
  persistence, and supersession one SQLite `BEGIN IMMEDIATE` transaction, with
  an eight-process concurrency regression test.
- Routed structured handoffs through capture policy so private checkpoints receive
  bounded TTLs, per-agent/project quotas apply, and sensitive/restricted checkpoints
  remain quarantined for review.
- Excluded historical handoff records from lifecycle context packs; startup now
  injects only the latest task/project/branch-applicable structured checkpoint.
- Scoped checkpoint idempotency to task and branch, returned the persisted payload
  on retries, and rejected conflicting reuse of a checkpoint identity.
- Preserved handoff subject identity during correction, rebuilt structured metadata
  and rendered text together, and added a transactionally allocated checkpoint sequence.
- Made local embedding commands consistently resolve model caches from the effective
  CLI `--home`.
- Changed legacy audit migration to validate and preserve existing event hashes and
  report historical corruption or SQLite/JSONL divergence instead of rewriting evidence.
- Distributed store/query adapters and large-scale load harness.
- Sandboxed Tree-sitter workers and Git staleness projector.
- OIDC/mTLS identity adapter and compliance purge coordinator.

## [0.5.0] - 2026-09-10

- Added an opt-in built-in `bge-small-en-v1.5` q8 local embedding provider with
  pinned model revision, byte sizes, SHA-256 verification, private cache,
  offline mode, and WASM-only inference.
- Added local model status/pull/backfill CLI commands and reproducible quality
  and performance benchmarks.
- Added query/document-specific BGE encoding, code-identifier normalization,
  bounded WordPiece tokenization, and idempotent content-hash-aware backfill.
- Kept the inference runtime optional so lexical/graph-only installations can
  use `--omit=optional`.

## [0.4.0] - 2026-09-10

- Added HTTP-backed stdio MCP mode for one authoritative store across clients and machines.
- Added first-class structured handoff checkpoints with task and branch-aware latest retrieval.
- Added automatic lifecycle hook adapter and Claude Code/Cursor examples without raw transcript capture.
- Added an opt-in loopback review inbox for approval, correction, rejection, provenance inspection and context preview.
- Fixed Git provenance by scanning committed blobs rather than dirty working-tree files.
- Fixed branch handling across capture, conflict detection, lexical/vector/graph retrieval and content deduplication.
- Made token budgets account for the complete serialized context-pack response.
- Moved the audit hash chain into transactionally serialized SQLite events for safe multi-process append ordering.

## [0.3.0] - 2026-09-10

- Added policy-controlled automatic agent capture over MCP, HTTP and CLI.
- Added risk-based active/proposed/quarantined promotion with bounded TTLs,
  project quotas, conflict keys and locally verified Git evidence.
- Split capture, proposal, approval, feedback and administration scopes so an
  agent cannot approve or delete its own memories.
- Separated authenticated principal from shared memory owner for cross-agent transfer.
- Added non-destructive agent feedback with bounded ranking influence.
- Added recursive credential scanning and write-rate limits for agent-facing MCP.

## [0.2.0] - 2026-09-09

- Rebranded the public package as ContinuityDB to avoid the occupied
  `context-vault` package name.
- Added tenant/agent scopes, temporal validity, typed graph edges and hash-chained audit.
- Added optional hybrid semantic retrieval, RRF, MMR and freshness/trust signals.
- Added secure-by-default HTTP API, CLI and Git repository scanner.
- Added PostgreSQL/pgvector partition schema, Docker/CI, OpenAPI, threat model,
  scalability gates and competitor research.

## [0.1.0] - 2026-09-09

- Initial local SQLite/FTS5 proof of concept with read-only MCP.
