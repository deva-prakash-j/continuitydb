# ContinuityDB architecture v0.3

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
CLI admin ------------------------------------+
                                                v
MCP read/capture -> identity + capture policy -> SQLite records/FTS5/vectors/edges
HTTP v1 ---------> auth/rate limit -----------+          |
                                                +-> canonical Markdown
                                                +-> hash-chained audit JSONL
```

- SQLite WAL is the query/index engine for one host.
- FTS5 handles exact identifiers, paths, errors and keywords.
- Optional embeddings come from Ollama or an OpenAI-compatible endpoint and are
  stored as versioned derived rows. Local vector retrieval is an exact bounded scan.
- Project and memory edges provide bounded graph expansion.
- RRF fuses lexical, semantic and graph ranks; MMR reduces repeated context.
- Automatic capture has a separate write-rate limit, per-agent/project quota,
  TTL caps, recursive credential rejection and conflict quarantine.

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
`deploy/postgres`; v0.3 changes are an additive `002` migration with owner-aware
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
4. Retrieve lexical candidates and optional semantic candidates.
5. Expand graph neighbors from bounded seeds.
6. Fuse ranks using weighted Reciprocal Rank Fusion.
7. Apply project proximity, confidence, importance, freshness and exact-score boosts.
8. Use Maximal Marginal Relevance to reduce duplicate evidence.
9. Pack within the caller budget and return citations plus score signals.

## Consistency and failure behavior

- Local canonical files are written atomically before the rebuildable index.
- Tenant/owner/namespace-scoped idempotency keys prevent duplicate proposals on
  retries without colliding across project boundaries.
- Embeddings must match canonical content hash; stale projections are ignored.
- Forgetting tombstones the record and removes it from all local retrieval paths.
- Distributed mode uses canonical transaction + outbox/log; projectors are
  idempotent and query responses expose index generation/freshness.
- Audit entries form a SHA-256 hash chain. Production needs remote signed checkpoints.

## Stable surfaces

- JavaScript library: `ContextVault`, `HybridEngine` and security/ranking helpers.
- CLI: `continuitydb` lifecycle, graph, export, repo scan, doctor and serve commands.
- HTTP: versioned `/v1` API described by `docs/openapi.yaml`.
- MCP: `memory_search`, `memory_context_pack`, `memory_capture` and
  `memory_feedback`; no approval or administration tools.

## Explicit non-goals for v0.3

- passive screen, clipboard or raw-chat surveillance;
- treating retrieved text as policy or authorization;
- claiming global scale from a 10k-record laptop benchmark;
- forcing personal and employer memories into one physical trust domain;
- implementing a new vector database instead of interoperating with proven engines.
