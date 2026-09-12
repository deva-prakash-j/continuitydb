# Changelog

All notable changes are documented here. The project follows Semantic Versioning
after the first stable release.

## [Unreleased]

- Added one-command complete project adapters for Codex, Claude Code, OpenCode,
  Cursor, and VS Code Copilot, with truthful `policy-led`, `hook-enforced`,
  `plugin+policy`, and `hook+policy` recall labels plus an explicit `--mcp-only`
  escape hatch.
- Made generated agent policy require explicit durable-memory intent for
  governed capture, forbid raw prompt/transcript/tool-log capture and
  plan/read-only bypasses, and require the truthful result `not saved` whenever
  capture is denied or unavailable.
- Expanded client validation to generate and verify all 12 managed assets,
  compare all four generated hook/policy examples with actual adapter output,
  semantically validate all 12 shipped client examples, reject any new example
  without an explicit validator, and reuse
  the same tree validator against the standalone binary's output.
- Required Node 22/24, container, Linux binary, and all supported native release
  jobs to run blocking client-adapter validation before artifact publication.
- Added a Node single-executable build that includes the runtime, SQLite,
  ContinuityDB application, and integrity-pinned ONNX/WASM inference runtime.
- Added versioned user-scoped self-install with no shell-profile mutation and
  safe refusal to overwrite unmanaged launchers.
- Added `setup`, `agents detect/status/connect/disconnect`, `run`, bundled
  `hook`, and `version` commands for end-to-end binary operation.
- Added idempotent, backup-preserving project configuration for Codex, Claude
  Code, OpenCode, Cursor, and VS Code Copilot without storing token values.
- Added Linux binary and semantic inference smoke tests plus a native
  Linux/macOS/Windows release matrix, checksums, and provenance attestations.
- Added scope-filtered MCP tool discovery with explicit read-only/non-destructive
  annotations for GitHub Copilot and other safety-aware clients.
- Added authenticated stateful Streamable HTTP MCP sessions with identity
  binding, capacity/idle limits, explicit termination, and metrics.
- Added static bearer and verified OIDC JWT service identities, OAuth protected
  resource metadata, and versioned Codex, Copilot, Claude Code, and OpenCode
  client configurations.
- Added contract tests for client adapters, a real Codex CLI transport/discovery
  probe, corrected Claude Code hook output, and an explicit-file-only OpenCode
  lifecycle plugin.
- Refused symlinked or replaced lifecycle checkpoint files in both the hook CLI
  and OpenCode adapter before parsing or capture.
- Revalidated held handoff lineage inside the approval transaction, returning
  HTTP 409 for stale successors and allowing exactly one winner under concurrent
  reviews; valid approvals receive a fresh sequence and bounded activation TTL.
- Blocked direct store commit/capture calls from activating handoffs outside the
  governed save or review paths.
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
