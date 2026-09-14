import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextVault } from "../src/store.js";
import { evaluateGraphCoverage, resolveGraphSeeds, traverseGraph } from "../src/graph/retrieval.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-retrieval-"));
  const vault = new ContextVault(root);
  const node = (qualified_name, repo_path = `src/${qualified_name.split(".").at(-1)}.java`, extra = {}) => ({
    qualified_name, label: qualified_name.split(".").at(-1), repo_path, kind: "method", ...extra,
  });
  const target = node("com.acme.OrderMapper.toDto");
  const callerA = node("com.acme.OrderController.list");
  const callerB = node("com.acme.OrderService.load");
  const projection = vault.publishGraph({
    project_id: "orders-api", branch: "main", commit: "abc123", extractor_version: "test-v1",
    source_states: [target, callerA, callerB].map((item) => ({ repo_path: item.repo_path, git_object_id: item.qualified_name })),
    nodes: [target, callerA, callerB],
    edges: [
      { source: callerA, target, relation: "calls", repo_path: callerA.repo_path, start_line: 10, provenance: "extracted" },
      { source: callerB, target, relation: "calls", repo_path: callerB.repo_path, start_line: 20, provenance: "resolved" },
      { source: callerA, target: callerB, relation: "calls", repo_path: callerA.repo_path, start_line: 30, provenance: "inferred" },
      { source: callerB, target: callerA, relation: "calls", repo_path: callerB.repo_path, start_line: 40, provenance: "extracted" },
    ],
  });
  const secret = node("corp.payroll.PayrollExporter.run", "src/PayrollExporter.java");
  vault.publishGraph({
    project_id: "payroll", branch: "main", commit: "secret", extractor_version: "test-v1",
    source_states: [{ repo_path: secret.repo_path, git_object_id: "secret" }], nodes: [secret], edges: [],
  });
  vault.linkProjects({ source_project: "orders-api", target_project: "orders-schema", provenance: "pom.xml" });
  return { root, vault, projection, target, cleanup() { vault.close(); rmSync(root, { recursive: true, force: true }); } };
}

const scope = {
  query: "Who calls OrderMapper.toDto?", project_id: "orders-api",
  allowed_projects: ["orders-api", "orders-schema"], branch: "main",
};

test("exact seeds and incoming traversal are authorized, bounded, stable, and explainable", () => {
  const f = fixture();
  try {
    const seeds = resolveGraphSeeds(f.vault, scope);
    assert.equal(seeds[0].qualified_name, "com.acme.OrderMapper.toDto");
    assert.equal(seeds[0].seed_match, "exact");
    const first = traverseGraph(f.vault, { ...scope, direction: "incoming", depth: 2, strict_evidence: true });
    const second = traverseGraph(f.vault, { ...scope, direction: "incoming", depth: 2, strict_evidence: true });
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first).includes("payroll"), false);
    assert.equal(first.some((item) => item.graph_path.some((hop) => hop.provenance === "inferred")), false);
    assert.ok(first.every((item) => item.depth <= 2));
  } finally { f.cleanup(); }
});

test("FTS seeds follow exact resolution and caller-supplied seeds are re-authorized", () => {
  const f = fixture();
  try {
    const lexical = resolveGraphSeeds(f.vault, { ...scope, query: "OrderMapper conversion" });
    assert.equal(lexical[0].seed_match, "fts");
    const injected = traverseGraph(f.vault, {
      ...scope,
      seeds: [{
        id: "fabricated", generation_id: f.projection.id, project_id: "orders-api",
        qualified_name: "corp.payroll.Secret", label: "payroll", score: 1,
      }],
    });
    assert.deepEqual(injected, []);
  } finally { f.cleanup(); }
});

test("graph-only detailed search keeps the array wrapper and excludes unauthorized projects", () => {
  const f = fixture();
  try {
    const input = { ...scope, retrieval_mode: "graph-only", graph_depth: 2 };
    const detailed = f.vault.searchDetailed(input);
    assert.deepEqual(detailed.retrieval, {
      requested_mode: "graph-only", effective_mode: "graph-only", semantic_fallback_used: false,
      fallback_reason: null, graph_generation: detailed.retrieval.graph_generation,
    });
    assert.ok(detailed.results.length > 0);
    assert.ok(detailed.results[0].graph_path.every((hop) => ["extracted", "resolved"].includes(hop.provenance)));
    assert.equal(JSON.stringify(detailed).includes("payroll"), false);
    assert.deepEqual(f.vault.search(input), detailed.results);
    assert.equal(evaluateGraphCoverage({ seeds: [], candidates: [] }).fallback_reason, "no_seed");
  } finally { f.cleanup(); }
});

test("depth, path budgets, stale generations, and administrative paths are enforced", () => {
  const f = fixture();
  try {
    const depthZero = traverseGraph(f.vault, { ...scope, depth: 0 });
    assert.ok(depthZero.every((candidate) => candidate.depth === 0));
    assert.ok(traverseGraph(f.vault, { ...scope, maxPaths: 1 }).length <= 1);
    assert.throws(() => traverseGraph(f.vault, { ...scope, depth: 4 }), /depth must be between 0 and 3/);
    const explanation = f.vault.explainGraphNode({ ...scope, node: "com.acme.OrderMapper.toDto" });
    assert.equal(explanation.node.qualified_name, "com.acme.OrderMapper.toDto");
    const path = f.vault.findGraphPath({ ...scope, from: "com.acme.OrderController.list", to: "com.acme.OrderMapper.toDto", direction: "outgoing" });
    assert.equal(path.graph_path[0].relation, "calls");

    f.vault.publishGraph({
      project_id: "orders-api", branch: "main", commit: "empty", extractor_version: "test-v2",
      source_states: [{ repo_path: "README.md", git_object_id: "empty" }],
      nodes: [{ qualified_name: "Current", label: "Current", repo_path: "README.md", kind: "document" }], edges: [],
    });
    assert.equal(resolveGraphSeeds(f.vault, scope).length, 0);
  } finally { f.cleanup(); }
});
