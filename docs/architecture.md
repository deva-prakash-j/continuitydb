# ContinuityDB architecture v0.6

## Design principles

1. Provider-neutral MCP and HTTP contracts.
2. Canonical, versioned records/events; every query index is rebuildable.
3. Authorization filters before retrieval, not after ranking.
4. Git evidence is commit/branch/path/symbol aware.
5. Local-first embedded mode and horizontally scalable distributed mode share a
   contract, not an unsuitable common database.
6. Automatic capture is policy-controlled: agents can capture but cannot approve,
   correct, delete, broaden scope or grant durability to themselves.

## Embedded runtime

```text
CLI admin ----------------------------------------------------+
                                                               v
local MCP --------> identity + capture policy ----------------> SQLite records/FTS5/vectors/edges
remote MCP ------> authenticated Streamable HTTP MCP ----------^        |
remote stdio MCP -> authenticated HTTP v1 -> authoritative API          |
lifecycle hooks ---------------------------------------------+          +-> canonical Markdown
review inbox ------------------------------------------------+          +-> versioned code-graph projections
                                                                        +-> serialized audit table
```

- SQLite WAL is the query/index engine for one host.
- FTS5 handles exact identifiers, paths, errors and keywords.
- Optional embeddings come from the pinned built-in BGE-small q8 WASM provider,
  Ollama, or an OpenAI-compatible endpoint and are stored as model/content-hash
  versioned derived rows. Local vector retrieval is an exact bounded scan.
- Project and memory edges provide bounded graph expansion.
- Committed Java/Spring, manifest, configuration, and Markdown evidence is
  stored in atomically published graph generations. Exact/FTS graph seeds and
  authorized typed traversal run before optional semantic fallback.
- RRF fuses lexical, semantic and graph ranks; MMR reduces repeated context.
- Automatic capture has a separate write-rate limit, per-agent/project quota,
  TTL caps, recursive credential rejection and conflict quarantine.
- Structured handoffs have enforced task identity, state, completed work,
  unresolved questions, next actions, branch/commit and relevant-file fields.
  They pass through capture policy: private checkpoints are active only with a
  bounded TTL, per-agent/project quotas apply, and sensitive/restricted
  checkpoints wait for review. Successor checkpoints use
  `previous_checkpoint_id` as an optimistic compare-and-set token. A stale or
  missing predecessor is quarantined; an accepted successor atomically
  supersedes the prior active checkpoint.

## Distributed runtime target

```text
OIDC/mTLS gateway
      |
stateless query API -> policy snapshot
      |---- lexical adapter
      |---- vector adapter
      |---- graph adapter
      +---- fusion/rerank/context pack

ingest API -> canonical transaction + outbox -> durable log
                                         |---- lexical projector
                                         |---- embedding projector
                                         |---- graph projector
                                         +---- staleness/deletion projector
```

The repository includes the first PostgreSQL/pgvector partition schema under
`deploy/postgres`; v0.3 changes included an additive `002` migration with owner-aware
row-level security. Runtime adapters and distributed load evidence are release
gates, not implied by the schema. See [scalability](scalability.md).

## Record model

- identity: tenant, shared owner, authenticated principal and originating agent;
- scope: namespace, project, branch and sensitivity;
- content: type, title, body, tags and structured metadata;
- source: source type/URI, repository path, symbol and Git commit;
- truth time: valid-from/valid-to plus observed/recorded timestamps;
- lifecycle: proposed, active, superseded, tombstoned or quarantined;
- quality: importance, confidence, stale state, version and expiry;
- retry safety: content hash and tenant/owner/namespace-scoped idempotency key.
- capture policy: server-derived source trust, disposition and bounded lifetime;
  only exact Git excerpts can receive durable Git-verified provenance.

Typed project and memory edges carry weight, provenance and validity windows.

## Retrieval

1. Resolve server-bound tenant/principal/agent identity.
2. Compute explicit project dependency closure within the caller allowlist.
3. Apply tenant, owner, namespace, sensitivity, status, branch, expiry, valid-time
   and stale filters inside every retriever.
4. For `graph-only` and `graph-first`, resolve exact
   symbol/path/configuration/dependency seeds, then graph FTS seeds and traverse
   authorized typed edges with depth, visited-node, and path budgets. `hybrid`
   intentionally skips the native graph as the legacy rollback baseline.
5. Evaluate graph coverage. In `graph-first`, invoke semantic retrieval only for
   `no_seed`, `insufficient_candidates`, `low_path_confidence`, or
   `conceptual_query`; `graph-only` never embeds and `hybrid` embeds eagerly.
6. Fuse the mode-applicable lexical, semantic, record, and graph-path ranks using weighted RRF.
7. Apply project proximity, confidence, importance, freshness and exact-score boosts.
8. Use Maximal Marginal Relevance to reduce duplicate evidence.
9. Pack the full serialized envelope within the caller budget and return
    citations, evidence paths, requested/effective mode, fallback reason, and
    active generation metadata.

`hybrid` remains the compatibility default until the frozen ablation demonstrates
no downstream answer-accuracy regression, at least 20% lower median context
tokens, at least 60% embedding avoidance on exact/structural questions, and zero
scope or stale-generation failures. See [graph-first retrieval](graph-first-retrieval.md).

## Consistency and failure behavior

- Local canonical files are written atomically before the rebuildable index.
- Tenant/owner/namespace-scoped idempotency keys prevent duplicate proposals on
  retries without colliding across project boundaries.
- Handoff idempotency additionally includes task and branch. Retries return the
  persisted checkpoint, conflicting payload reuse is rejected, and a SQLite
  AUTOINCREMENT sequence gives latest-checkpoint lookup a deterministic order.
  Handoff lineage validation, quota calculation, sequence allocation, insert,
  and prior-checkpoint supersession run under one `BEGIN IMMEDIATE` transaction,
  so concurrent processes cannot exceed quota or publish two active successors.
- Embeddings must match canonical content hash; stale projections are ignored.
- A graph build publishes a complete staging generation in one transaction;
  readers see either the prior active generation or the complete replacement.
  Changed-file builds reuse unchanged extracted facts, while extractor-version
  changes force reparsing. Incomplete snapshots, extractor failures, changed
  repository HEADs, and stale active-generation compare-and-swap attempts refuse
  publication. Graph projections remain rebuildable and do not replace governed
  records.
- Forgetting tombstones the record and removes it from all local retrieval paths.
- Distributed mode uses canonical transaction + outbox/log; projectors are
  idempotent and query responses expose index generation/freshness.
- Audit entries form a SHA-256 hash chain in a SQLite `BEGIN IMMEDIATE`
  transaction, preventing separate local processes from appending against stale
  heads. Legacy JSONL hashes are validated and preserved; broken or divergent
  history remains visible as an invalid migration instead of being re-hashed.
  Production still needs remote signed checkpoints.

## Stable surfaces

- JavaScript library: `ContextVault`, `HybridEngine` and security/ranking helpers.
- CLI: `continuitydb` lifecycle, graph, export, repo scan, doctor and serve commands.
- HTTP: versioned `/v1` API and authenticated stateful Streamable HTTP MCP
  endpoint described by `docs/openapi.yaml`.
- MCP: memory search/context/capture/feedback plus structured handoff checkpoint/latest;
  no approval or administration tools. It can run against local storage or proxy
  to the authoritative HTTP service.

## Explicit non-goals for v0.6

- passive screen, clipboard or raw-chat surveillance;
- treating retrieved text as policy or authorization;
- claiming global scale from a 10k-record laptop benchmark;
- forcing personal and employer memories into one physical trust domain;
- implementing a new vector database instead of interoperating with proven engines.
