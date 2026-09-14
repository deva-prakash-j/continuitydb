import assert from "node:assert/strict";
import test from "node:test";
import {
  graphEdgeId,
  graphNodeId,
  normalizeGraphBudgets,
  normalizeGraphProjection,
} from "../src/graph/model.js";

test("graph IDs are deterministic and scope-bound", () => {
  const input = {
    tenant_id: "tenant-a",
    project_id: "billing",
    repo_path: "src/Api.java",
    kind: "class",
    qualified_name: "com.acme.Api",
  };
  assert.equal(graphNodeId(input), graphNodeId({ ...input }));
  assert.notEqual(graphNodeId(input), graphNodeId({ ...input, project_id: "ledger" }));
  assert.equal(
    graphEdgeId({ source_id: "gn_source", target_id: "gn_target", relation: "calls", repo_path: "src/Api.java", start_line: 12 }),
    graphEdgeId({ source_id: "gn_source", target_id: "gn_target", relation: "calls", repo_path: "src/Api.java", start_line: 12 }),
  );
  assert.notEqual(
    graphEdgeId({ source_id: "gn_source", target_id: "gn_target", relation: "calls", source_location: "src/Api.java:12" }),
    graphEdgeId({ source_id: "gn_source", target_id: "gn_target", relation: "calls", source_location: "src/Api.java:13" }),
  );
});

test("graph budgets reject traversal wider than the public contract", () => {
  assert.deepEqual(normalizeGraphBudgets({ depth: 2 }), { depth: 2, maxVisited: 400, maxPaths: 40 });
  assert.throws(() => normalizeGraphBudgets({ depth: 4 }), /depth must be between 0 and 3/);
});

test("graph projections normalize paths, validate provenance, and hash independent of input order", () => {
  const base = {
    tenant_id: "tenant-a",
    project_id: "api",
    branch: "main",
    commit: "abcdef1",
    extractor_version: "graph-v1",
    source_states: [{ repo_path: "src/./Api.java", git_object_id: "blob-a", extractor_version: "graph-v1" }],
    nodes: [
      { repo_path: "src/Api.java", kind: "class", qualified_name: "com.acme.Api", provenance: "extracted" },
      { repo_path: "src/Util.java", kind: "class", qualified_name: "com.acme.Util", provenance: "extracted" },
    ],
    edges: [{
      source: { repo_path: "src/Api.java", kind: "class", qualified_name: "com.acme.Api" },
      target: { repo_path: "src/Util.java", kind: "class", qualified_name: "com.acme.Util" },
      relation: "calls",
      repo_path: "src/Api.java",
      start_line: 9,
      provenance: "resolved",
    }],
  };
  const normalized = normalizeGraphProjection(base);
  const reversed = normalizeGraphProjection({
    ...base,
    nodes: [...base.nodes].reverse(),
    source_states: [...base.source_states].reverse(),
  });
  assert.equal(normalized.hash, reversed.hash);
  assert.equal(normalized.source_states[0].repo_path, "src/Api.java");
  assert.equal(normalized.edges[0].source_id, normalized.nodes[0].id);
  assert.throws(
    () => normalizeGraphProjection({ ...base, edges: [{ ...base.edges[0], provenance: "unverified" }] }),
    /edge provenance is invalid/,
  );
});

test("graph projections use the same identifier scope contract as graph reads", () => {
  const projection = {
    tenant_id: "tenant-a",
    project_id: "api team",
    branch: "main",
    commit: "abcdef1",
    extractor_version: "graph-v1",
    source_states: [],
    nodes: [],
    edges: [],
  };
  assert.throws(() => normalizeGraphProjection(projection), /project_id contains invalid characters or length/);
  assert.throws(() => normalizeGraphProjection({ ...projection, project_id: "api", branch: "main branch" }), /branch contains invalid characters or length/);
  assert.throws(() => normalizeGraphProjection({ ...projection, project_id: "api", branch: " main " }), /branch contains invalid characters or length/);
});

test("graph normalization rejects absolute source locations and falsey explicit provenance", () => {
  assert.throws(
    () => graphEdgeId({ source_id: "gn_source", target_id: "gn_target", relation: "calls", source_location: "C:/repo/file:1" }),
    /source_location must be a repository-relative path/,
  );
  assert.throws(
    () => graphEdgeId({ source_id: "gn_source", target_id: "gn_target", relation: "calls", source_location: "C:\\repo\\file:1" }),
    /source_location must be a repository-relative path/,
  );
  assert.throws(
    () => normalizeGraphProjection({
      tenant_id: "tenant-a",
      project_id: "api",
      branch: "main",
      commit: "abcdef1",
      extractor_version: "graph-v1",
      source_states: [],
      nodes: [{ repo_path: "src/Api.java", kind: "class", qualified_name: "com.acme.Api", provenance: "" }],
      edges: [],
    }),
    /node provenance is invalid/,
  );
});
