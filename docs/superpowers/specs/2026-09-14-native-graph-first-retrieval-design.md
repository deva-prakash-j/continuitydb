# Native Graph-First Retrieval Design

**Date:** 2026-09-14
**Status:** Approved for implementation

## Goal

Make ContinuityDB retrieval graph-first for code and engineering context so it
returns smaller, more causally relevant context packs while retaining optional
semantic retrieval as a bounded fallback for vague natural-language queries.

The first production slice targets Java/Spring repositories plus their Maven or
Gradle manifests, YAML/JSON configuration, Markdown documentation, and Git
provenance. The design remains provider-neutral and local-first.

## Current state

ContinuityDB already has the foundations of a hybrid retriever:

- SQLite records and FTS5 lexical search;
- optional local or remote embeddings stored as rebuildable projections;
- typed project and memory edges;
- direct graph-neighbour expansion from lexical and semantic seeds;
- weighted reciprocal-rank fusion, MMR deduplication, temporal filtering,
  authorization filtering, citations, and token-budgeted context packs.

The limitation is not the absence of a graph. Graph expansion is currently a
shallow secondary signal over record-to-record edges, while repository ingest
captures only a limited set of symbols and dependency facts. A query therefore
still depends heavily on lexical or semantic seeds before graph structure can
help.

## Decision

Implement a native graph-first retrieval pipeline in the existing Node.js and
SQLite runtime. Use deterministic parsing and Git evidence to build the graph.
Do not add a permanent Python runtime, an external graph database, or a required
embedding service.

The retrieval order becomes:

1. exact identifier and lexical seed discovery;
2. bounded traversal of typed, provenance-bearing graph edges;
3. graph confidence and coverage evaluation;
4. optional semantic fallback only when graph-first evidence is insufficient;
5. fused ranking, diversity selection, and cited context packing.

Embeddings remain optional and rebuildable. They are a safety net, not the
primary index. A tree view represents containment, but the canonical relation
model is a graph because code and engineering decisions are many-to-many and
may contain cycles or cross-repository links.

## Alternatives considered

### Wrap Graphify as the runtime

This would provide broad language coverage quickly, but it creates a permanent
Python dependency and makes ContinuityDB installation, binary distribution,
security patching, and lifecycle control depend on another runtime. It is useful
as a benchmark and design reference, not as the production core.

### Move to Neo4j or FalkorDB

These engines offer mature graph algorithms, but they add operational services
to a product whose differentiator includes a single-host embedded mode. The
current scale does not justify that cost. A future distributed graph adapter can
implement the existing contract if benchmarked requirements outgrow SQLite.

### Replace embeddings with a strict tree

A tree is compact and useful for navigation, but it cannot faithfully represent
calls, imports, shared dependencies, cross-repository contracts, supersession,
or a decision that affects several files. Containment will be exposed as a tree
view over `contains` edges rather than used as the only retrieval structure.

## Graph model

### Nodes

Add a rebuildable code-graph projection with these node kinds in the first
slice:

- repository, project, module, source set, package;
- file, class, interface, enum, annotation;
- method, constructor, field, configuration key;
- Maven or Gradle dependency and Spring component or endpoint;
- document section, decision, and existing memory record.

Each code node carries a deterministic ID derived from tenant, project,
repository-relative path, symbol kind, qualified symbol, and source version.
It also records branch, Git commit, content hash, language, source range,
extractor version, and lifecycle validity. Repository-relative paths are stored;
unnecessary host paths are not exposed in query results.

Existing memory records remain canonical governed records. Code nodes are
rebuildable projections and do not become a competing memory source of truth.

### Edges

The first slice supports:

- `contains`, `declares`, `imports`, `calls`, `implements`, `extends`;
- `depends-on`, `reads-config`, `writes-config`, `exposes`, `consumes`;
- `documents`, `supports`, `contradicts`, `supersedes`, `affects`;
- links between a memory record and the exact code or Git evidence it cites.

Every edge records relation type, direction, weight, source location, Git
commit, validity window, extractor version, and provenance:

- `extracted` for a relationship explicit in source, manifests, configuration,
  or trusted Git metadata;
- `resolved` for a deterministic cross-file symbol-resolution result;
- `inferred` only when a separately identified heuristic or model produced it.

Inferred edges never receive the same default weight as extracted edges and are
excluded from strict evidence-only queries.

## Extraction and updates

Use tree-sitter-compatible deterministic parsing behind a small extractor
interface. The Java extractor identifies declarations, imports, inheritance,
method calls, annotations, Spring stereotypes, endpoints, and configuration-key
access. Dedicated deterministic parsers handle Maven, Gradle, YAML, JSON, and
Markdown structures.

Ingest is incremental:

1. resolve the authorized project and Git snapshot;
2. hash tracked files and compare them with the prior graph generation;
3. parse only added or changed files;
4. tombstone nodes and edges removed from the new snapshot;
5. resolve cross-file edges after local extraction;
6. atomically publish a complete graph generation;
7. retain enough generation metadata to diagnose staleness and rebuild safely.

An interrupted build never becomes the active generation. Existing records and
the previous active graph remain queryable until publication succeeds.

## Retrieval pipeline

### Seed discovery

Resolve exact qualified names, simple symbols, paths, dependency coordinates,
configuration keys, and error strings before general FTS ranking. Search both
governed records and graph nodes under the same tenant, owner, project, branch,
sensitivity, validity, and stale-state restrictions.

### Bounded traversal

Traverse from the strongest seeds with explicit budgets:

- default depth two, configurable from zero to three;
- maximum visited nodes and returned paths;
- relation-specific direction and weight;
- penalties for each hop and for inferred edges;
- no traversal across an unauthorized project or sensitivity boundary;
- deterministic ordering for equal scores.

Return the shortest high-confidence evidence paths, not an unbounded connected
component. Containment edges supply the tree-shaped navigation view; semantic
relations supply cross-tree evidence.

### Fallback gate

Evaluate graph-first retrieval before generating a query embedding. Semantic
fallback runs only when one or more configured conditions hold:

- no exact or lexical seed exists;
- fewer than the requested minimum graph candidates survive policy filters;
- the best graph path is below the confidence threshold;
- the query is explicitly classified as conceptual rather than identifier-led.

The response exposes whether fallback ran and why. Operators can choose
`graph-only`, `graph-first`, or the existing `hybrid` mode for benchmarking and
rollback. `graph-first` becomes the target default only after the release gates
pass.

### Ranking and packing

Fuse exact, lexical, graph-path, and optional semantic ranks. Preserve the
existing confidence, importance, freshness, project-proximity, and feedback
signals. Extend MMR so results on the same evidence path do not crowd out an
independent path.

Context packs include:

- the selected record or code excerpt;
- repository-relative citation, symbol, branch, and commit;
- the compact graph path that explains relevance;
- provenance and confidence for every edge in that path;
- retrieval mode, fallback reason, graph generation, and staleness state.

Packing remains constrained by the caller's token budget. Graph metadata is
trimmed before cited evidence.

## Interfaces and compatibility

Keep current MCP, HTTP, and JavaScript method names compatible. Add optional
request fields for retrieval mode, traversal depth, strict evidence, and graph
budgets. Add response metadata without removing existing fields.

Add administrative CLI surfaces for graph build, status, explain, path, and
rebuild. MCP remains read-mostly: it may search and request context but cannot
approve records, broaden scope, alter graph policy, or activate a graph
generation.

Existing vaults migrate additively. With no active code graph, retrieval behaves
as it does today. Graph projections can be deleted and rebuilt without changing
canonical Markdown, governed memory records, or audit history.

## Security and governance

- Apply authorization filters before seed selection, traversal, fallback, and
  ranking; never filter only after a path has been constructed.
- Treat graph labels, source text, documentation, and retrieved memories as
  untrusted evidence rather than instructions or authorization.
- Reject symlink escapes and paths outside the resolved Git root during ingest.
- Preserve tenant, owner, project, branch, namespace, sensitivity, temporal,
  lifecycle, and expiry isolation on nodes and edges.
- Keep automatic personal-memory capture disabled. This feature improves the
  Context Vault/ContinuityDB product and does not reconnect it to Gaya's active
  personal memory without a separate explicit approval.
- Record extractor version and source hashes so stale or tampered projections
  can be detected and rebuilt.

## Cost and performance targets

The primary cost target is total model-context consumption, not merely the
absence of a vector index. Deterministic extraction should use no hosted LLM
tokens. Graph-first retrieval should avoid query embeddings when strong
structural evidence exists and should return smaller context packs.

Measure at least:

- index wall time, peak memory, database size, and incremental update time;
- query p50/p95 latency and optional embedding invocations;
- retrieval recall at fixed `top_k`, citation/path correctness, and stale-result
  rate;
- context-pack tokens and downstream answer accuracy;
- results by query class: exact symbol, dependency impact, configuration flow,
  cross-repository path, conceptual question, and historical decision.

No cost or accuracy claim is accepted from Graphify's self-published benchmark
alone. Its repository is a design reference; ContinuityDB must pass its own
reproducible ablation benchmark.

## Delivery slices

### Slice 1: graph foundation and Java/Spring extraction

- additive node, edge, generation, and source-state schema;
- deterministic IDs and atomic generation publication;
- Java/Spring, Maven/Gradle, YAML/JSON, and Markdown extractors;
- incremental changed-file ingest;
- graph status and deterministic export for test inspection.

### Slice 2: graph-first retrieval

- exact seed resolution and bounded typed traversal;
- evidence paths and graph-aware ranking;
- fallback gate and retrieval-mode telemetry;
- compatible MCP, HTTP, CLI, and library request/response changes.

### Slice 3: evaluation and default decision

- a fixed set of 25–50 representative multi-repository engineering questions;
- current hybrid, graph-only, and graph-first-with-fallback ablations;
- accuracy, latency, embedding-call, and context-token reports;
- promote `graph-first` to default only if it meets the release gates.

Community detection, LLM-generated graph edges, broad language coverage, and an
external graph database are deferred until the first three slices prove value.

## Verification and release gates

- Unit tests for deterministic IDs, extraction, resolution, traversal budgets,
  edge provenance, temporal validity, and stable tie ordering.
- Isolation tests proving unauthorized nodes cannot become seeds, intermediate
  path nodes, fallback candidates, or packed evidence.
- Incremental-ingest tests for add, edit, rename, delete, rollback, concurrent
  readers, interrupted builds, and stale generation handling.
- Compatibility tests proving an old vault and old clients retain current
  behavior.
- Retrieval ablation with frozen fixtures and per-query evidence labels.
- Full existing test, lint, package, binary, and connector verification.

The implementation is releasable only if graph-first retrieval does not regress
answer accuracy against the current hybrid baseline, reduces median context-pack
tokens by at least 20% on the representative suite, avoids embeddings on at
least 60% of exact/structural queries, and introduces no cross-scope retrieval
or stale-generation failures.

## Rollback

The current hybrid retriever remains available behind an explicit mode. The
graph-first default, if promoted, can be changed back without deleting graph
data. The new tables are additive projections; rollback does not restore a
whole configuration, rewrite canonical records, or delete audit history.

Graph generations and optional embeddings remain rebuildable. Any destructive
cleanup of older projections is a separate explicitly approved operation.
