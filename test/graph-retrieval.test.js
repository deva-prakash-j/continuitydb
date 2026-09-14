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

test("branch generations remain separated and unauthorized intermediate nodes stop paths", () => {
  const f = fixture();
  try {
    f.vault.publishGraph({
      project_id: "orders-api", branch: "feature/private", commit: "feature", extractor_version: "test-v1",
      source_states: [{ repo_path: "src/FeatureOnly.java", git_object_id: "feature" }],
      nodes: [{ repo_path: "src/FeatureOnly.java", kind: "class", qualified_name: "private.FeatureOnly" }], edges: [],
    });
    assert.equal(resolveGraphSeeds(f.vault, { ...scope, query: "private.FeatureOnly", branch: "main" }).length, 0);
    assert.equal(resolveGraphSeeds(f.vault, { ...scope, query: "private.FeatureOnly", branch: "feature/private" }).length, 1);

    const start = { repo_path: "src/GateStart.java", kind: "class", qualified_name: "gate.Start" };
    const deniedNode = { repo_path: "src/PayrollBridge.java", kind: "class", qualified_name: "gate.PayrollBridge" };
    const behind = { repo_path: "src/AuthorizedBehind.java", kind: "class", qualified_name: "gate.AuthorizedBehind" };
    f.vault.publishGraph({
      project_id: "orders-api", branch: "main", commit: "gate", extractor_version: "test-v1",
      source_states: [start, deniedNode, behind].map((node) => ({ repo_path: node.repo_path, git_object_id: node.qualified_name })),
      nodes: [start, deniedNode, behind],
      edges: [
        { source: start, target: deniedNode, relation: "calls", repo_path: start.repo_path },
        { source: deniedNode, target: behind, relation: "calls", repo_path: deniedNode.repo_path },
      ],
    });
    const denied = f.vault.db.prepare("SELECT id FROM graph_nodes WHERE qualified_name = ?").get("gate.PayrollBridge");
    f.vault.db.prepare("UPDATE graph_nodes SET project_id = 'payroll' WHERE id = ?").run(denied.id);
    const traversed = traverseGraph(f.vault, { ...scope, query: "gate.Start", direction: "outgoing", depth: 3 });
    assert.equal(traversed.some((candidate) => candidate.id === denied.id), false);
    assert.equal(JSON.stringify(traversed).includes("PayrollBridge"), false);
    assert.equal(JSON.stringify(traversed).includes("AuthorizedBehind"), false);
  } finally { f.cleanup(); }
});

test("visited budgets cap breadth and inferred edges rank below extracted evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-budget-"));
  const vault = new ContextVault(root);
  try {
    const hub = { repo_path: "src/Hub.java", kind: "class", qualified_name: "budget.Hub" };
    const targets = Array.from({ length: 30 }, (_, index) => ({
      repo_path: `src/Target${index}.java`, kind: "class", qualified_name: `budget.Target${index}`,
    }));
    vault.publishGraph({
      project_id: "budget", branch: "main", commit: "budget", extractor_version: "test-v1",
      source_states: [hub, ...targets].map((node) => ({ repo_path: node.repo_path, git_object_id: node.qualified_name })),
      nodes: [hub, ...targets],
      edges: targets.map((target, index) => ({
        source: hub, target, relation: "calls", repo_path: hub.repo_path,
        start_line: index + 1, provenance: index === 29 ? "inferred" : "extracted",
      })),
    });
    const input = {
      query: "budget.Hub", project_id: "budget", allowed_projects: ["budget"], branch: "main",
      direction: "outgoing", depth: 1, maxPaths: 40,
    };
    const capped = traverseGraph(vault, { ...input, maxVisited: 25 });
    assert.equal(capped.length, 25);
    const all = traverseGraph(vault, { ...input, maxVisited: 400 });
    const extracted = all.find((candidate) => candidate.qualified_name === "budget.Target0");
    const inferred = all.find((candidate) => candidate.qualified_name === "budget.Target29");
    assert.ok(extracted.score > inferred.score);
    assert.ok(all.indexOf(extracted) < all.indexOf(inferred));
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage requires non-seed evidence and a meaningful scored path", () => {
  const isolatedSeed = {
    id: "isolated", seed_match: "exact", score: 1, depth: 0, graph_path: [],
  };
  assert.deepEqual(
    evaluateGraphCoverage({ seeds: [isolatedSeed], candidates: [isolatedSeed] }).fallback_reason,
    "insufficient_candidates",
  );
  const weakPath = {
    id: "weak", seed_match: "exact", score: 0.05, depth: 1,
    graph_path: [{ edge_id: "weak-edge" }],
  };
  assert.equal(
    evaluateGraphCoverage({ seeds: [isolatedSeed], candidates: [isolatedSeed, weakPath] }).fallback_reason,
    "low_path_confidence",
  );
});
