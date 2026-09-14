import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ContextVault } from "../src/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-final-review-"));
  const vault = new ContextVault(root);
  return {
    vault,
    cleanup() {
      vault.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function node(qualified_name, extra = {}) {
  return {
    repo_path: extra.repo_path || `src/${qualified_name.split(".").at(-1)}.java`,
    kind: extra.kind || "class",
    qualified_name,
    label: qualified_name.split(".").at(-1),
    ...extra,
  };
}

function projection(project_id, branch, commit, nodes, edges = [], extra = {}) {
  return {
    project_id,
    branch,
    commit,
    extractor_version: "final-review-v1",
    source_states: [...new Map(nodes.map((item) => [item.repo_path, {
      repo_path: item.repo_path,
      git_object_id: `${commit}:${item.repo_path}`,
    }])).values()],
    nodes,
    edges,
    ...extra,
  };
}

test("graph seed and traversal authorization enforce owner, namespace, sensitivity, lifecycle, and expiry", () => {
  const f = fixture();
  try {
    const visible = node("scope.Visible");
    const restricted = node("scope.Restricted", { sensitivity: "restricted" });
    const wrongNamespace = node("scope.WrongNamespace", { namespace_id: "project/other" });
    const inactive = node("scope.Inactive", { lifecycle_status: "tombstoned" });
    const expired = node("scope.Expired", { expires_at: "2026-01-01T00:00:00Z" });
    f.vault.publishGraph(projection("api", "main", "scope", [
      visible, restricted, wrongNamespace, inactive, expired,
    ], [{
      source: visible,
      target: restricted,
      relation: "calls",
      repo_path: visible.repo_path,
      sensitivity: "restricted",
    }], {
      tenant_id: "acme",
      owner_id: "alice",
      namespace_id: "project/api",
      sensitivity: "private",
    }));

    const base = {
      tenant_id: "acme",
      project_id: "api",
      allowed_projects: ["api"],
      branch: "main",
      retrieval_mode: "graph-only",
      as_of: "2026-09-14T00:00:00Z",
    };
    assert.equal(f.vault.searchDetailed({
      ...base, owner_id: "bob", allowed_sensitivities: ["private", "restricted"], query: "scope.Visible",
    }).results.length, 0);
    assert.equal(f.vault.searchDetailed({
      ...base, owner_id: "alice", allowed_sensitivities: [], query: "scope.Visible",
    }).results.length, 0);

    const authorized = f.vault.searchDetailed({
      ...base, owner_id: "alice", allowed_sensitivities: ["private"], query: "scope.Visible", direction: "outgoing",
    });
    assert.deepEqual(authorized.results.map((item) => item.citation.symbol), ["scope.Visible"]);
    const governedProjection = f.vault.activeGraphProjection({
      tenant_id: "acme", owner_id: "alice", project_id: "api", branch: "main",
      allowed_sensitivities: ["private"], allowed_namespaces: ["project/api"],
      as_of: "2026-09-14T00:00:00Z",
    });
    assert.deepEqual(governedProjection.nodes.map((item) => item.qualified_name), ["scope.Visible"]);
    assert.equal(governedProjection.edges.length, 0);
    const governedStatus = f.vault.graphStatus({
      tenant_id: "acme", owner_id: "alice", project_id: "api", branch: "main",
      allowed_sensitivities: ["private"], allowed_namespaces: ["project/api"],
      as_of: "2026-09-14T00:00:00Z",
    });
    assert.equal(governedStatus.nodes, 1);
    assert.equal(governedStatus.edges, 0);
    for (const denied of ["scope.Restricted", "scope.WrongNamespace", "scope.Inactive", "scope.Expired"]) {
      assert.equal(f.vault.searchDetailed({
        ...base, owner_id: "alice", allowed_sensitivities: ["private"], query: denied,
      }).results.length, 0, denied);
    }
  } finally {
    f.cleanup();
  }
});

test("an omitted branch is the branch-null scope and never selects the latest named branch", () => {
  const f = fixture();
  try {
    f.vault.publishGraph(projection("api", null, "default", [node("branch.Default")]));
    f.vault.publishGraph(projection("api", "feature/private", "private", [node("branch.FeaturePrivate")]));
    const input = {
      project_id: "api", allowed_projects: ["api"], retrieval_mode: "graph-only",
    };
    assert.equal(f.vault.searchDetailed({ ...input, query: "branch.FeaturePrivate" }).results.length, 0);
    assert.equal(f.vault.searchDetailed({ ...input, query: "branch.Default" }).results.length, 1);
    assert.equal(f.vault.activeGraphGeneration({ project_id: "api" }).commit, "default");
    assert.equal(f.vault.graphStatus({ project_id: "api" }).active_generation.commit, "default");
    assert.equal(f.vault.graphStatus({ project_id: "api" }).nodes, 1);
  } finally {
    f.cleanup();
  }
});

test("historical as_of selects the generation whose lifecycle window contains the request", () => {
  const f = fixture();
  try {
    f.vault.publishGraph(projection("api", "main", "old", [node("history.Old")], [], {
      valid_from: "2026-01-01T00:00:00Z",
    }));
    f.vault.publishGraph(projection("api", "main", "new", [node("history.New")], [], {
      valid_from: "2026-06-01T00:00:00Z",
    }));
    const input = {
      project_id: "api", allowed_projects: ["api"], branch: "main", retrieval_mode: "graph-only",
    };
    const historical = f.vault.searchDetailed({ ...input, query: "history.Old", as_of: "2026-03-01T00:00:00Z" });
    assert.equal(historical.results[0].citation.symbol, "history.Old");
    assert.equal(historical.retrieval.graph_generation.commit, "old");
    assert.equal(f.vault.searchDetailed({ ...input, query: "history.New", as_of: "2026-03-01T00:00:00Z" }).results.length, 0);
    assert.equal(f.vault.searchDetailed({ ...input, query: "history.New", as_of: "2026-08-01T00:00:00Z" }).results.length, 1);
  } finally {
    f.cleanup();
  }
});

test("cross-project evidence edges can target an authorized node in another active generation", () => {
  const f = fixture();
  try {
    const target = node("com.acme.schema.OrderCreated", {
      project_id: "schema",
      repo_path: "src/OrderCreated.java",
    });
    const targetGeneration = f.vault.publishGraph(projection("schema", "main", "schema-v1", [target]));
    const source = node("com.acme.api.OrderPublisher", { repo_path: "src/OrderPublisher.java" });
    f.vault.publishGraph(projection("api", "main", "api-v1", [source], [{
      source,
      target: { ...target, generation_id: targetGeneration.id },
      relation: "calls",
      repo_path: source.repo_path,
      provenance: "resolved",
    }]));
    f.vault.linkProjects({ source_project: "api", target_project: "schema", provenance: "pom.xml" });

    const result = f.vault.searchDetailed({
      query: "com.acme.api.OrderPublisher",
      project_id: "api",
      allowed_projects: ["api", "schema"],
      branch: "main",
      retrieval_mode: "graph-only",
      direction: "outgoing",
    });
    const crossProject = result.results.find((item) => item.citation.symbol === "com.acme.schema.OrderCreated");
    assert.ok(crossProject);
    assert.equal(crossProject.project_id, "schema");
    assert.equal(crossProject.graph_path[0].target_generation_id, targetGeneration.id);
  } finally {
    f.cleanup();
  }
});

test("exact governed-memory citations become dynamically authorized memory-to-code graph evidence", () => {
  const f = fixture();
  try {
    const memory = f.vault.propose({
      project_id: "api",
      namespace_id: "project/api",
      title: "Outbox decision",
      body: "Use the committed OrderPublisher implementation.",
      source_type: "git",
      source_uri: "git://api/src/OrderPublisher.java",
      repo_path: "src/OrderPublisher.java",
      symbol: "com.acme.api.OrderPublisher",
      git_commit: "api-v1",
      branch: "main",
    });
    f.vault.commit(memory.record.id);
    const code = node("com.acme.api.OrderPublisher", {
      repo_path: "src/OrderPublisher.java",
      excerpt: "public final class OrderPublisher {}",
    });
    f.vault.publishGraph(projection("api", "main", "api-v1", [code]));

    const result = f.vault.searchDetailed({
      query: "Outbox decision",
      project_id: "api",
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
      branch: "main",
      retrieval_mode: "graph-only",
      direction: "outgoing",
    });
    assert.ok(result.results.some((item) => item.id === memory.record.id || item.memory_id === memory.record.id));
    assert.ok(result.results.some((item) => item.citation.symbol === "com.acme.api.OrderPublisher"));
    assert.ok(result.results.some((item) => item.graph_path.some((hop) => hop.relation === "supports")));

    f.vault.db.prepare("UPDATE memory_records SET status = 'tombstoned' WHERE id = ?").run(memory.record.id);
    const afterTombstone = f.vault.searchDetailed({
      query: "Outbox decision",
      project_id: "api",
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
      branch: "main",
      retrieval_mode: "graph-only",
    });
    assert.equal(JSON.stringify(afterTombstone).includes(memory.record.id), false);
  } finally {
    f.cleanup();
  }
});

test("legacy graph tables migrate additively into governed and cross-generation defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-migration-"));
  const index = join(root, "index");
  mkdirSync(index, { recursive: true });
  const legacy = new DatabaseSync(join(index, "context-vault.db"));
  legacy.exec(`
    CREATE TABLE graph_generations (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '', "commit" TEXT NOT NULL,
      extractor_version TEXT NOT NULL, projection_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT, superseded_at TEXT
    );
    CREATE INDEX idx_graph_generations_scope_status
      ON graph_generations(tenant_id, project_id, branch, status, activated_at DESC);
    CREATE UNIQUE INDEX idx_graph_generations_one_active
      ON graph_generations(tenant_id, project_id, branch) WHERE status = 'active';
    CREATE TABLE graph_nodes (
      tenant_id TEXT NOT NULL, generation_id TEXT NOT NULL, id TEXT NOT NULL,
      project_id TEXT NOT NULL, repo_path TEXT NOT NULL, kind TEXT NOT NULL,
      qualified_name TEXT NOT NULL, label TEXT NOT NULL, branch TEXT, "commit" TEXT NOT NULL,
      content_hash TEXT, language TEXT, start_line INTEGER, start_column INTEGER,
      end_line INTEGER, end_column INTEGER, extractor_version TEXT NOT NULL,
      provenance TEXT NOT NULL, valid_from TEXT, valid_to TEXT, stale INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(tenant_id, generation_id, id)
    );
    CREATE TABLE graph_edges (
      tenant_id TEXT NOT NULL, generation_id TEXT NOT NULL, id TEXT NOT NULL,
      source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL,
      source_location TEXT NOT NULL, repo_path TEXT, start_line INTEGER, start_column INTEGER,
      end_line INTEGER, end_column INTEGER, weight REAL NOT NULL, provenance TEXT NOT NULL,
      "commit" TEXT NOT NULL, extractor_version TEXT NOT NULL, valid_from TEXT, valid_to TEXT,
      stale INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id, generation_id, id)
    );
    INSERT INTO graph_generations VALUES (
      'legacy-generation', 'local', 'api', 'main', 'legacy', 'legacy-v1', 'legacy-hash',
      'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    );
    INSERT INTO graph_nodes VALUES (
      'local', 'legacy-generation', 'legacy-node', 'api', 'src/Legacy.java', 'class',
      'legacy.Legacy', 'Legacy', 'main', 'legacy', NULL, 'java', 1, 1, 1, 7,
      'legacy-v1', 'extracted', NULL, NULL, 0
    );
    INSERT INTO graph_edges VALUES (
      'local', 'legacy-generation', 'legacy-edge', 'legacy-node', 'legacy-node', 'contains',
      'src/Legacy.java:1', 'src/Legacy.java', 1, 1, 1, 7, 1, 'extracted', 'legacy',
      'legacy-v1', NULL, NULL, 0
    );
  `);
  legacy.close();

  const vault = new ContextVault(root);
  try {
    const generation = vault.activeGraphGeneration({ project_id: "api", branch: "main" });
    assert.equal(generation.owner_id, "local-user");
    assert.equal(generation.namespace_id, "project/api");
    assert.equal(generation.sensitivity, "private");
    const migratedNode = vault.db.prepare("SELECT * FROM graph_nodes WHERE id = 'legacy-node'").get();
    assert.equal(migratedNode.owner_id, "local-user");
    assert.equal(migratedNode.namespace_id, "project/api");
    const migratedEdge = vault.db.prepare("SELECT * FROM graph_edges WHERE id = 'legacy-edge'").get();
    assert.equal(migratedEdge.project_id, "api");
    assert.equal(migratedEdge.source_generation_id, "legacy-generation");
    assert.equal(migratedEdge.target_generation_id, "legacy-generation");
    assert.equal(migratedEdge.branch, "main");
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
