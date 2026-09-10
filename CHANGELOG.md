# Changelog

All notable changes are documented here. The project follows Semantic Versioning
after the first stable release.

## [Unreleased]

- Distributed store/query adapters and large-scale load harness.
- Sandboxed Tree-sitter workers and Git staleness projector.
- OIDC/mTLS identity adapter and compliance purge coordinator.

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
