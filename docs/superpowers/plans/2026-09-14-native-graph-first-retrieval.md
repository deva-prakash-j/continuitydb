# Native Graph-First Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build native, deterministic Java/Spring code-graph indexing and graph-first retrieval with embeddings invoked only as a measured fallback.

**Architecture:** Store versioned code nodes and typed edges as rebuildable SQLite projections beside the existing governed memory records. Resolve exact and lexical graph seeds, traverse only authorized bounded paths, and call the existing semantic retriever only when graph evidence fails an explicit coverage gate; preserve old search behavior through a compatibility method and selectable retrieval modes.

**Tech Stack:** Node.js 24, built-in `node:sqlite`, built-in test runner, existing FTS5/RRF/MMR helpers, Git committed-blob reads, dependency-free deterministic Java/Spring and manifest extractors.

**Spec:** `docs/superpowers/specs/2026-09-14-native-graph-first-retrieval-design.md`

## Global Constraints

- Keep the implementation native to the existing Node.js and SQLite runtime; add no permanent Python runtime, external graph database, or required embedding service.
- Keep embeddings optional and rebuildable; `graph-first` becomes the default only after the benchmark release gates pass.
- Apply tenant, owner, project, branch, namespace, sensitivity, lifecycle, temporal, expiry, and stale filters before seed selection, traversal, fallback, and ranking.
- Use deterministic parsing and committed Git blobs; reject symlinks, denied paths, binary content, and paths outside the resolved Git root.
- Default graph depth is two; accepted request depth is zero through three, with explicit visited-node and returned-path budgets.
- Preserve current MCP, HTTP, CLI, JavaScript, canonical Markdown, governed memory, and audit behavior when no active graph exists.
- Keep automatic personal-memory capture disabled and do not reconnect ContinuityDB to Gaya's active memory.
- Graph-first promotion requires no answer-accuracy regression, at least 20% lower median context-pack tokens, at least 60% embedding avoidance on exact/structural queries, and zero cross-scope or stale-generation failures.
- Do not modify or commit the existing untracked `marketing/` directory.

## File Structure

- Create `src/graph/model.js`: relation allowlists, deterministic IDs, node/edge normalization, and graph budget validation.
- Create `src/graph/java-spring-extractor.js`: dependency-free deterministic Java/Spring declaration and relation extraction.
- Create `src/graph/structured-extractors.js`: Maven, Gradle, YAML, JSON, and Markdown graph extraction.
- Create `src/graph/repository-graph.js`: committed-blob graph construction, changed-file detection, and incremental carry-forward planning.
- Create `src/graph/retrieval.js`: exact/FTS seed retrieval, bounded traversal, path scoring, and coverage decisions.
- Modify `src/repo-ingest.js`: expose one safe committed-snapshot reader shared by record and graph ingestion.
- Modify `src/store.js`: additive graph schema, atomic generation publication, graph queries, and compatibility-safe detailed search.
- Modify `src/embeddings.js`: retrieval-mode dispatch and semantic fallback gate.
- Modify `src/mcp-server.js`, `src/http-server.js`, `src/cli.js`, and `docs/openapi.yaml`: optional graph-first inputs and additive retrieval metadata/admin commands.
- Create `benchmarks/graph-first-fixture.json` and `benchmarks/graph-first-benchmark.js`: frozen ablation suite and report generator.
- Modify `package.json`, `README.md`, `docs/architecture.md`, and `benchmarks/README.md`: commands and behavior documentation.
- Create `test/graph-model.test.js`, `test/java-spring-extractor.test.js`, `test/structured-extractors.test.js`, `test/repository-graph.test.js`, and `test/graph-retrieval.test.js`; extend existing interface and compatibility tests.

---

### Task 1: Versioned graph projection and atomic publication

**Files:**
- Create: `src/graph/model.js`
- Modify: `src/store.js`
- Create: `test/graph-model.test.js`
- Modify: `test/store.test.js`

**Interfaces:**
- Produces: `graphNodeId(input): string`, `graphEdgeId(input): string`, `normalizeGraphProjection(input): GraphProjection`, and `normalizeGraphBudgets(input): GraphBudgets` from `src/graph/model.js`.
- Produces: `ContextVault.publishGraph(projection): GraphGeneration`, `ContextVault.graphStatus(scope): GraphStatus`, and `ContextVault.activeGraphGeneration(scope): GraphGeneration | null`.
- Consumes later: `GraphProjection` with `{ tenant_id, project_id, branch, commit, extractor_version, source_states, nodes, edges }`.

- [ ] **Step 1: Write failing model tests**

```js
test("graph IDs are deterministic and scope-bound", () => {
  const input = { tenant_id: "tenant-a", project_id: "billing", repo_path: "src/Api.java", kind: "class", qualified_name: "com.acme.Api" };
  assert.equal(graphNodeId(input), graphNodeId({ ...input }));
  assert.notEqual(graphNodeId(input), graphNodeId({ ...input, project_id: "ledger" }));
});

test("graph budgets reject traversal wider than the public contract", () => {
  assert.deepEqual(normalizeGraphBudgets({ depth: 2 }), { depth: 2, maxVisited: 400, maxPaths: 40 });
  assert.throws(() => normalizeGraphBudgets({ depth: 4 }), /depth must be between 0 and 3/);
});
```

- [ ] **Step 2: Run model tests and confirm the missing-module failure**

Run: `node --test test/graph-model.test.js`

Expected: FAIL because `src/graph/model.js` does not exist.

- [ ] **Step 3: Implement deterministic graph normalization**

```js
export const GRAPH_RELATIONS = new Set([
  "contains", "declares", "imports", "calls", "implements", "extends",
  "depends-on", "reads-config", "writes-config", "exposes", "consumes",
  "documents", "supports", "contradicts", "supersedes", "affects",
]);

export function graphNodeId(input) {
  const identity = [input.tenant_id, input.project_id, input.repo_path, input.kind, input.qualified_name].join("\u0000");
  return `gn_${createHash("sha256").update(identity).digest("hex")}`;
}

export function normalizeGraphBudgets({ depth = 2, maxVisited = 400, maxPaths = 40 } = {}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error("depth must be between 0 and 3");
  return { depth, maxVisited: bounded(maxVisited, 25, 2_000), maxPaths: bounded(maxPaths, 1, 200) };
}
```

Implement `graphEdgeId` from source ID, target ID, relation, and source location. Normalize paths to repository-relative POSIX form, reject unknown relations/provenance, and sort nodes/edges deterministically before hashing the projection.

- [ ] **Step 4: Add failing atomic-publication tests**

```js
test("publishing a graph atomically supersedes the previous generation", () => {
  const f = fixture();
  try {
    const first = f.vault.publishGraph(graphFixture({ commit: "a" }));
    const second = f.vault.publishGraph(graphFixture({ commit: "b" }));
    assert.equal(f.vault.activeGraphGeneration({ project_id: "api" }).id, second.id);
    assert.equal(f.vault.graphStatus({ project_id: "api" }).generations.superseded, 1);
    assert.notEqual(first.id, second.id);
  } finally { f.cleanup(); }
});

test("an invalid projection leaves the active generation unchanged", () => {
  const f = fixture();
  try {
    const active = f.vault.publishGraph(graphFixture({ commit: "a" }));
    assert.throws(() => f.vault.publishGraph(graphFixture({ commit: "b", danglingEdge: true })), /unknown target node/);
    assert.equal(f.vault.activeGraphGeneration({ project_id: "api" }).id, active.id);
  } finally { f.cleanup(); }
});
```

- [ ] **Step 5: Add the additive SQLite schema and transactional publication**

Add `graph_generations`, `graph_source_states`, `graph_nodes`, `graph_node_fts`, and `graph_edges`. Key all projection rows by tenant and generation. Add indexes for active project/branch lookup, qualified-name lookup, path lookup, and incoming/outgoing traversal. Enforce one active generation per tenant/project/normalized branch with a partial unique index.

`publishGraph` must normalize the complete projection before opening `BEGIN IMMEDIATE`, insert the new generation as `staging`, insert all rows, verify every edge endpoint exists in that generation, mark the prior active generation `superseded`, mark the staging generation `active`, append one audit event, and commit. Roll back on every exception.

- [ ] **Step 6: Run focused graph and store tests**

Run: `node --test test/graph-model.test.js test/store.test.js`

Expected: PASS, including old-vault initialization and audit-chain tests.

- [ ] **Step 7: Commit the graph projection foundation**

```bash
git add src/graph/model.js src/store.js test/graph-model.test.js test/store.test.js
git commit -m "feat: add versioned code graph projections"
```

---

### Task 2: Deterministic Java/Spring and structured-file extraction

**Files:**
- Create: `src/graph/java-spring-extractor.js`
- Create: `src/graph/structured-extractors.js`
- Create: `test/java-spring-extractor.test.js`
- Create: `test/structured-extractors.test.js`

**Interfaces:**
- Produces: `extractJavaSpring({ tenantId, projectId, repoPath, commit, branch, text }): { nodes, edges }`.
- Produces: `extractStructuredGraph({ tenantId, projectId, repoPath, commit, branch, text }): { nodes, edges }`.
- Consumes: model normalization and deterministic ID functions from Task 1.

- [ ] **Step 1: Write failing Java/Spring fixture tests**

Use a fixture containing a package, imports, interface implementation, injected constructor, `@RestController`, `@GetMapping`, `@Value`, and a method call. Assert exact node qualified names and these extracted edges:

```js
assert.deepEqual(relations(result), [
  "calls:com.acme.OrderController.list->com.acme.OrderService.findAll",
  "contains:src/main/java/com/acme/OrderController.java->com.acme.OrderController",
  "exposes:com.acme.OrderController.list->GET /orders",
  "implements:com.acme.OrderService->com.acme.OrderPort",
  "imports:src/main/java/com/acme/OrderController.java->org.springframework.web.bind.annotation.RestController",
  "reads-config:com.acme.OrderController->orders.page-size",
]);
```

Also assert comments and string literals do not create declarations or method-call edges, overloaded method IDs include normalized parameter arity, and output order is stable across runs.

- [ ] **Step 2: Run the Java extractor test and confirm failure**

Run: `node --test test/java-spring-extractor.test.js`

Expected: FAIL because the extractor module does not exist.

- [ ] **Step 3: Implement a dependency-free parser behind the graph extractor contract**

Implement a scanner that masks comments and string bodies while preserving offsets, tokenizes identifiers/punctuation/annotations, tracks brace scopes, and emits package, import, type, method, field, annotation, endpoint, configuration-key, and resolvable local-call facts. Keep parsing and graph mapping as separate internal functions:

```js
export function extractJavaSpring(input) {
  const tokens = tokenizeJava(input.text);
  const syntax = parseJavaStructure(tokens);
  return mapJavaStructureToGraph(input, syntax);
}
```

The returned contract must be parser-agnostic so a tree-sitter adapter can replace the scanner later without changing storage or retrieval. Mark syntax facts `extracted` and cross-file name matches `resolved`; do not emit model-generated `inferred` edges in this slice.

- [ ] **Step 4: Write failing Maven/Gradle/YAML/JSON/Markdown tests**

```js
assert.ok(edgesFor("pom.xml").some((edge) => edge.relation === "depends-on" && edge.target.qualified_name === "org.springframework:spring-web"));
assert.ok(edgesFor("application.yml").some((edge) => edge.relation === "declares" && edge.target.qualified_name === "server.port"));
assert.ok(nodesFor("ADR-004.md").some((node) => node.kind === "document-section" && node.qualified_name === "ADR-004#Decision"));
```

Include Gradle Kotlin/Groovy dependency notation, nested YAML keys, JSON pointers, Markdown headings, duplicate keys, malformed input, and denied secret-like keys. Secret values must never enter node labels, summaries, or metadata.

- [ ] **Step 5: Implement structured extractors**

Use bounded deterministic parsing. Emit dependency coordinates without repository credentials, configuration-key names without values, and Markdown section headings plus bounded non-secret summaries. Return an empty projection for malformed or unsupported files and include a structured diagnostic count rather than throwing after repository safety validation.

- [ ] **Step 6: Run extractor tests**

Run: `node --test test/java-spring-extractor.test.js test/structured-extractors.test.js`

Expected: PASS with deterministic snapshots.

- [ ] **Step 7: Commit deterministic extractors**

```bash
git add src/graph/java-spring-extractor.js src/graph/structured-extractors.js test/java-spring-extractor.test.js test/structured-extractors.test.js
git commit -m "feat: extract Java Spring code graphs"
```

---

### Task 3: Safe committed-snapshot graph building and incremental updates

**Files:**
- Modify: `src/repo-ingest.js`
- Create: `src/graph/repository-graph.js`
- Modify: `test/repo-ingest.test.js`
- Create: `test/repository-graph.test.js`

**Interfaces:**
- Produces: `readCommittedSnapshot(inputPath, options): { repository, files, skipped, truncated }` from `src/repo-ingest.js`.
- Produces: `buildRepositoryGraph(vault, inputPath, options): GraphBuildResult` from `src/graph/repository-graph.js`.
- Consumes: Task 1 publication APIs and Task 2 extractors.

- [ ] **Step 1: Write failing committed-snapshot compatibility tests**

Extend `test/repo-ingest.test.js` to assert `readCommittedSnapshot` returns bytes only from `git cat-file`, excludes dirty-worktree text, rejects a non-root scan path, skips Git symlinks and denied basenames, enforces file/byte limits, and redacts userinfo from remotes. Assert existing `scanRepository` output is unchanged for the same fixture.

- [ ] **Step 2: Run repository-ingest tests and confirm the missing export**

Run: `node --test test/repo-ingest.test.js`

Expected: FAIL because `readCommittedSnapshot` is not exported.

- [ ] **Step 3: Refactor the shared committed snapshot reader**

Move the existing Git root, tree listing, committed blob, size, binary, denylist, symlink, branch, commit, and remote-sanitization behavior into `readCommittedSnapshot`. Keep file text internal to callers and never include it in CLI results. Make `scanRepository` map the snapshot to its existing memory-record contract.

- [ ] **Step 4: Write failing graph-build and incremental tests**

```js
const first = buildRepositoryGraph(vault, repo, { projectId: "orders" });
assert.equal(first.parsed_files, 4);

commitChange(repo, "README.md", "unrelated text");
const second = buildRepositoryGraph(vault, repo, { projectId: "orders" });
assert.equal(second.reused_files, 3);
assert.equal(second.parsed_files, 1);
assert.equal(vault.activeGraphGeneration({ project_id: "orders" }).commit, head(repo));
```

Add rename, delete, branch separation, extractor-version invalidation, interrupted pre-publication build, concurrent reader, and unsupported-file tests. Assert removed nodes exist only in the superseded generation and never in active retrieval.

- [ ] **Step 5: Implement incremental graph construction**

Read the active generation's source-state rows. Reuse prior normalized nodes and edges for files whose Git object ID and extractor version match. Parse changed files, resolve cross-file edges over the combined node set, calculate one deterministic projection hash, then call `publishGraph`. Return counts for scanned, parsed, reused, denied, unsupported, removed, nodes, edges, and diagnostics.

- [ ] **Step 6: Run repository tests**

Run: `node --test test/repo-ingest.test.js test/repository-graph.test.js`

Expected: PASS, including dirty-worktree and interrupted-build protections.

- [ ] **Step 7: Commit incremental graph ingest**

```bash
git add src/repo-ingest.js src/graph/repository-graph.js test/repo-ingest.test.js test/repository-graph.test.js
git commit -m "feat: build graph from committed repository snapshots"
```

---

### Task 4: Authorized graph-first retrieval and explainable paths

**Files:**
- Create: `src/graph/retrieval.js`
- Modify: `src/store.js`
- Create: `test/graph-retrieval.test.js`
- Modify: `test/store.test.js`
- Modify: `test/temporal-graph.test.js`

**Interfaces:**
- Produces: `resolveGraphSeeds(vault, input): GraphSeed[]`, `traverseGraph(vault, input): GraphCandidate[]`, and `evaluateGraphCoverage(input): GraphCoverage`.
- Produces: `ContextVault.searchDetailed(input): { results, retrieval }`; existing `ContextVault.search(input): Result[]` remains compatible.
- Produces: `ContextVault.explainGraphNode(input)` and `ContextVault.findGraphPath(input)` for read-only administration.

- [ ] **Step 1: Write failing seed and traversal tests**

Create a two-project fixture where `orders-api` is allowed to depend on
`orders-schema`, while `payroll` is not allowed. Assert:

```js
const detailed = vault.searchDetailed({
  query: "Who calls OrderMapper.toDto?",
  project_id: "orders-api",
  allowed_projects: ["orders-api", "orders-schema"],
  retrieval_mode: "graph-only",
  graph_depth: 2,
});
assert.deepEqual(detailed.retrieval, {
  requested_mode: "graph-only",
  effective_mode: "graph-only",
  semantic_fallback_used: false,
  fallback_reason: null,
  graph_generation: detailed.retrieval.graph_generation,
});
assert.ok(detailed.results[0].graph_path.every((hop) => hop.provenance === "extracted" || hop.provenance === "resolved"));
assert.equal(JSON.stringify(detailed).includes("payroll"), false);
```

Add tests for incoming and outgoing direction, cycles, stable ties, depth zero,
visited/path caps, branch scope, temporal validity, stale generations, inferred
edge penalties, strict-evidence exclusion, and an unauthorized intermediate node.

- [ ] **Step 2: Run graph retrieval tests and confirm failure**

Run: `node --test test/graph-retrieval.test.js test/temporal-graph.test.js`

Expected: FAIL because graph retrieval APIs do not exist.

- [ ] **Step 3: Implement exact and FTS seed resolution**

Normalize qualified identifiers, method-like tokens, repository paths,
dependency coordinates, configuration keys, and quoted error fragments. Run
exact lookups before `graph_node_fts`. Put tenant, project allowlist, branch,
generation, validity, and provenance constraints inside every SQL query.

- [ ] **Step 4: Implement bounded typed traversal**

Use an iterative breadth-first traversal with a visited best-score map rather
than returning a connected component:

```js
while (frontier.length && depth < budgets.depth && visited.size < budgets.maxVisited) {
  const edges = vault.authorizedGraphEdges({ ...scope, node_ids: frontier.map((item) => item.id) });
  frontier = scoreAndDeduplicate(edges, { hop: depth + 1, strictEvidence, visited });
  paths.push(...frontier.slice(0, budgets.maxPaths - paths.length));
  depth += 1;
}
```

Score exact seeds above FTS seeds, extracted above resolved above inferred, and
apply relation-specific weights plus hop decay. Reject every edge whose target
cannot be fetched under the same authorization predicate.

- [ ] **Step 5: Implement detailed search and compatibility wrapper**

`searchDetailed` must combine existing governed-record candidates and graph
evidence, apply existing RRF, trust/freshness/feedback boosts, and graph-aware
MMR, then pack results within the existing token envelope. Each graph result
includes a compact cited path. `search` returns only `searchDetailed(input).results`
so old library callers retain the array contract.

- [ ] **Step 6: Run retrieval, store, temporal, and ranking tests**

Run: `node --test test/graph-retrieval.test.js test/store.test.js test/temporal-graph.test.js test/ranking.test.js`

Expected: PASS with zero unauthorized node IDs, labels, or paths in results.

- [ ] **Step 7: Commit graph-first retrieval**

```bash
git add src/graph/retrieval.js src/store.js test/graph-retrieval.test.js test/store.test.js test/temporal-graph.test.js
git commit -m "feat: retrieve bounded graph evidence paths"
```

---

### Task 5: Semantic fallback gate and compatible external interfaces

**Files:**
- Modify: `src/embeddings.js`
- Modify: `src/mcp-server.js`
- Modify: `src/http-server.js`
- Modify: `src/cli.js`
- Modify: `docs/openapi.yaml`
- Modify: `test/embeddings.test.js`
- Modify: `test/mcp-server.test.js`
- Modify: `test/http-server.test.js`
- Modify: `test/cli.test.js`

**Interfaces:**
- Produces: `HybridEngine.searchDetailed(input)` and compatible `HybridEngine.search(input)`.
- Accepts: `retrieval_mode` in `"hybrid" | "graph-only" | "graph-first"`, `graph_depth` in `0..3`, `strict_evidence`, `graph_max_visited`, and `graph_max_paths`.
- Adds: `{ retrieval: { requested_mode, effective_mode, semantic_fallback_used, fallback_reason, graph_generation } }` beside existing result arrays in detailed MCP/HTTP responses.

- [ ] **Step 1: Write failing fallback-decision tests**

Use a counting embedder and assert no embedding call for an exact graph path,
one call for a conceptual query with weak graph coverage, no call in
`graph-only`, and immediate semantic inclusion in legacy `hybrid` mode:

```js
const answer = await engine.searchDetailed({ query: "OrderController", project_id: "orders", retrieval_mode: "graph-first" });
assert.equal(embedder.queryCalls, 0);
assert.equal(answer.retrieval.semantic_fallback_used, false);
```

Also assert fallback reasons are one of `no_seed`, `insufficient_candidates`,
`low_path_confidence`, or `conceptual_query`, and a stale/unauthorized graph
cannot suppress fallback.

- [ ] **Step 2: Run embedding tests and confirm failure**

Run: `node --test test/embeddings.test.js`

Expected: FAIL because `searchDetailed` and retrieval modes are absent.

- [ ] **Step 3: Implement mode dispatch and one-shot fallback**

Call `vault.searchDetailed` without semantic candidates first for `graph-first`.
If `evaluateGraphCoverage` requests fallback and an embedder exists, create one
query embedding, retrieve authorized semantic candidates, and rerun detailed
fusion once. Never embed in `graph-only`; preserve the existing eager behavior
in `hybrid`. Return `fallback_reason: "semantic_unavailable"` when fallback is
needed but no embedder is configured.

- [ ] **Step 4: Add failing MCP, HTTP, and CLI contract tests**

Assert old requests still work with omitted graph fields, new bounds reject
depth four and oversized budgets, MCP remains read-only, HTTP authorization is
applied before graph traversal, and detailed responses keep `results` while
adding `retrieval`. Add CLI tests for:

```text
continuitydb graph build --repo PATH --project orders --apply
continuitydb graph status --project orders
continuitydb graph explain --project orders --node com.acme.OrderController
continuitydb graph path --project orders --from com.acme.OrderController --to com.acme.OrderService
continuitydb search --query OrderController --project orders --mode graph-first --depth 2
```

Preview build must not mutate the vault. The four graph commands must output
bounded JSON and redact host-only paths from query results.

- [ ] **Step 5: Implement interface validation and graph CLI commands**

Extend the existing Zod/request validators with optional fields and defaults.
Use one shared request normalizer in MCP and HTTP paths. Wire CLI graph build to
Task 3, and status/explain/path to Task 4 read-only methods. Keep approval and
administration unavailable over MCP.

- [ ] **Step 6: Update and validate OpenAPI**

Document the optional request fields, retrieval metadata, graph path hop schema,
error bounds, and backward-compatible defaults. Run:

`npm run validate:openapi`

Expected: PASS.

- [ ] **Step 7: Run interface tests**

Run: `node --test test/embeddings.test.js test/mcp-server.test.js test/http-server.test.js test/cli.test.js`

Expected: PASS, including the existing tool list and authorization tests.

- [ ] **Step 8: Commit fallback and interfaces**

```bash
git add src/embeddings.js src/mcp-server.js src/http-server.js src/cli.js docs/openapi.yaml test/embeddings.test.js test/mcp-server.test.js test/http-server.test.js test/cli.test.js
git commit -m "feat: add graph-first retrieval fallback"
```

---

### Task 6: Reproducible ablation benchmark, documentation, and release gates

**Files:**
- Create: `benchmarks/graph-first-fixture.json`
- Create: `benchmarks/graph-first-benchmark.js`
- Modify: `benchmarks/README.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Create: `docs/graph-first-retrieval.md`
- Modify: `test/release-workflow.test.js`

**Interfaces:**
- Produces: `npm run benchmark:graph-first` and a JSON report with per-mode and per-query-class metrics.
- Consumes: all graph build, detailed retrieval, and fallback telemetry from Tasks 1–5.

- [ ] **Step 1: Create the frozen representative fixture**

Add 30 labeled questions across exact symbol, call path, dependency impact,
configuration flow, cross-project path, conceptual query, and historical
decision classes. Each fixture entry contains authorized projects, branch,
gold node IDs or memory IDs, required citation edges, and maximum acceptable
staleness. Include at least five negative isolation queries whose forbidden
projects must never appear.

- [ ] **Step 2: Write the failing benchmark test contract**

Extend `test/release-workflow.test.js` to require the script and fixture, require
the package command, and validate the report schema:

```js
assert.deepEqual(Object.keys(report.modes).sort(), ["graph-first", "graph-only", "hybrid"]);
assert.equal(report.security.cross_scope_failures, 0);
assert.equal(Number.isFinite(report.modes["graph-first"].median_context_tokens), true);
assert.equal(Number.isFinite(report.modes["graph-first"].embedding_avoidance_rate), true);
```

- [ ] **Step 3: Run the release-workflow test and confirm failure**

Run: `node --test test/release-workflow.test.js`

Expected: FAIL because the benchmark assets and package command are absent.

- [ ] **Step 4: Implement the deterministic ablation runner**

Build one temporary fixture vault, run every question through `hybrid`,
`graph-only`, and `graph-first`, and calculate recall at fixed `top_k`, required
path coverage, p50/p95 latency, context tokens, embedding invocations, stale
results, and cross-scope failures. Seed the same records and graph generation
for every mode and write stable JSON with environment/version metadata.

Exit non-zero when cross-scope/stale failures are non-zero or when the promoted
default gates fail. Until the gates pass, report `recommended_default: "hybrid"`;
only a later evidence-backed commit changes the runtime default.

- [ ] **Step 5: Document architecture, operation, and rollback**

Document graph build/status/explain/path, retrieval modes, fallback reasons,
generation lifecycle, incremental behavior, privacy boundaries, rebuild and
rollback. State that Graphify inspired the deterministic/provenance approach,
its published benchmarks are not ContinuityDB evidence, and no Graphify runtime
or source code is bundled.

- [ ] **Step 6: Run benchmark and focused validation**

Run:

```bash
npm run benchmark:graph-first
npm run validate:openapi
npm run validate:clients
node --test test/graph-model.test.js test/java-spring-extractor.test.js test/structured-extractors.test.js test/repository-graph.test.js test/graph-retrieval.test.js test/embeddings.test.js test/mcp-server.test.js test/http-server.test.js test/cli.test.js test/release-workflow.test.js
```

Expected: commands PASS; the benchmark report truthfully keeps or promotes the
default according to measured gates.

- [ ] **Step 7: Commit benchmark and documentation**

```bash
git add benchmarks/graph-first-fixture.json benchmarks/graph-first-benchmark.js benchmarks/README.md package.json README.md docs/architecture.md docs/graph-first-retrieval.md test/release-workflow.test.js
git commit -m "test: benchmark graph-first retrieval"
```

---

### Task 7: Full verification and clean handoff

**Files:**
- Modify only files required to fix failures introduced by Tasks 1–6.

**Interfaces:**
- Consumes: the complete implementation and all existing project release gates.
- Produces: a verified branch with no unrelated files staged or committed.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run release checks**

Run: `npm run release:check`

Expected: PASS. If a network-only audit or external platform probe is unavailable,
record the exact failed command and preserve all completed local evidence.

- [ ] **Step 3: Run binary and reproducibility checks**

Run:

```bash
npm run test:binary
npm run test:binary:semantic
npm run test:binary:reproducible
```

Expected: PASS on the current supported platform without bundling Python,
Graphify, an external graph database, or a required embedding service.

- [ ] **Step 4: Verify repository scope and commits**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors; only the pre-existing untracked `marketing/`
directory remains outside the feature commits; commits are ordered design,
graph projection, extraction, ingest, retrieval, interfaces, and benchmark/docs.

- [ ] **Step 5: Record the final evidence**

Report exact test totals, benchmark metrics, default-mode decision, binary
checks, unavailable checks, and residual risks. Do not claim Graphify parity or
cost savings beyond the measured ContinuityDB fixture.
