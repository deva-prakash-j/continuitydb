# Native graph-first retrieval

ContinuityDB can index a deterministic code graph from committed Java/Spring,
Maven or Gradle, YAML/JSON, and Markdown files. The graph is a rebuildable SQLite
projection beside governed memory records. It does not make source text a memory
record or an authorization source.

`hybrid` remains the default. Operators can select `graph-only` or `graph-first`
per request while collecting evidence for promotion.

## Build and inspect a graph

Graph ingestion reads Git tree entries and blobs for the resolved commit. Dirty
worktree content, symlinks, binary data, denied secret-like paths, and paths
outside the repository root are rejected or skipped before extraction.

```bash
# Preview in a disposable vault; the configured vault is not changed.
continuitydb graph build --repo /path/to/repository --project orders-api

# Publish one complete active generation.
continuitydb graph build --repo /path/to/repository --project orders-api --apply

continuitydb graph status --project orders-api --branch main
continuitydb graph explain --project orders-api --branch main \
  --node com.acme.orders.OrderController
continuitydb graph path --project orders-api --branch main \
  --from com.acme.orders.OrderController.list \
  --to com.acme.orders.OrderService.findAll
```

Builds compare tracked blob IDs with the prior active generation. Unchanged files
reuse their extracted facts; added, changed, renamed, and removed files are
reconciled before deterministic cross-file resolution. An extractor-version
change invalidates reuse. Publication inserts a staging generation and all of its
nodes and edges in one transaction, verifies edge endpoints, supersedes the old
generation, and activates the replacement. An interrupted or invalid build
leaves the previous generation active.

## Retrieval modes

| Mode | Seed/traversal behavior | Semantic behavior |
|---|---|---|
| `hybrid` | Lexical records plus the authorized graph | Generates a query embedding eagerly when configured |
| `graph-only` | Exact/FTS seeds and bounded typed paths only | Never generates an embedding |
| `graph-first` | Runs the graph coverage gate first | Embeds only when graph evidence is insufficient |

The compatibility default is `hybrid`. A search request can add:

```json
{
  "query": "Who calls OrderMapper.toDto?",
  "project_id": "orders-api",
  "retrieval_mode": "graph-first",
  "graph_depth": 2,
  "graph_max_visited": 400,
  "graph_max_paths": 40,
  "strict_evidence": true
}
```

Depth defaults to two and accepts zero through three. `strict_evidence` excludes
inferred nodes and edges. Responses preserve existing result fields and add the
requested/effective mode, whether semantic fallback ran, its reason, the active
graph generation, repository-relative citations, and compact evidence paths.

The graph-first fallback reasons are:

- `no_seed`: no authorized exact or lexical graph seed survived;
- `insufficient_candidates`: the requested minimum evidence was not reached;
- `low_path_confidence`: the best authorized path missed the confidence gate;
- `conceptual_query`: a longer non-exact question needs semantic evidence;
- `semantic_unavailable`: fallback was warranted but no embedder was configured.

## Privacy and validity boundaries

Tenant, owner, project dependency closure, branch, namespace, sensitivity,
lifecycle, validity time, expiry, and stale state are applied before seed
selection, traversal, fallback candidates, and packing. Unauthorized nodes cannot
be seeds or intermediate path nodes. Graph labels, documentation, source text,
and memories are untrusted evidence, never executable instructions or permission
to widen scope.

Every returned edge carries direction, provenance, weight, source location,
commit, and its deterministic ID. Results are tied to active generations. Code
nodes and optional embeddings can be rebuilt without rewriting canonical
Markdown records, governed memory lifecycle, or audit history. Automatic
personal-memory capture remains disabled unless separately enabled by an
operator.

## Benchmark and promotion gates

Run the frozen 30-query ablation:

```bash
npm run benchmark:graph-first
npm run benchmark:graph-first -- --output=/tmp/graph-first-report.json
# Validate a proposed promotion without changing runtime configuration.
npm run benchmark:graph-first -- --promote-default=graph-first
```

The runner uses one temporary vault and the same corpus for `graph-only`,
`graph-first`, and `hybrid`. It reports recall at fixed `top_k`, required path
coverage, latency, serialized context tokens, query-embedding calls, stale
evidence, and negative isolation results overall and by query class.

Promotion requires all of the following:

1. no downstream answer-accuracy regression against `hybrid`;
2. at least 20% lower median context-pack tokens;
3. at least 60% query-embedding avoidance on exact/structural questions;
4. zero cross-scope and stale-generation failures.

The repository benchmark intentionally does not call a downstream answer model;
it reports answer accuracy as unavailable instead of treating retrieval recall as
answer accuracy. A failed or unevaluated gate keeps `recommended_default` at
`hybrid`. Changing the runtime default requires a later evidence-backed change.
The optional promotion-check flag exits non-zero when its requested graph-first
promotion is ineligible; it never modifies runtime configuration.

Graphify inspired the deterministic extraction and provenance approach. Its
published benchmarks are not ContinuityDB evidence. ContinuityDB bundles no
Graphify runtime or source code and requires no Python runtime or external graph
database.

## Rebuild and rollback

Rebuild by running `graph build --apply` from the desired committed checkout. A
new complete generation replaces the active projection; canonical memory is not
changed. Verify the commit and counts with `graph status`, then inspect critical
symbols and paths with `graph explain` and `graph path`.

For retrieval rollback, set callers back to `retrieval_mode: "hybrid"`. This is
immediate and does not delete graph data. Do not delete old graph generations as
part of retrieval rollback: projection cleanup is a separate destructive
operation requiring explicit authorization. If a new build cannot validate or
publish, continue serving the previous active generation and investigate the
build diagnostics.
