import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextVault } from "../src/store.js";

test("temporal recall and memory graph expansion are tenant scoped", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-test-"));
  const vault = new ContextVault(root);
  try {
    const seed = vault.propose({
      tenant_id: "acme",
      owner_id: "alice",
      project_id: "api",
      namespace_id: "project/api",
      title: "SchemaV2 migration",
      body: "SchemaV2 migration starts the downstream rollout.",
      valid_from: "2026-01-01T00:00:00Z",
    });
    const related = vault.propose({
      tenant_id: "acme",
      owner_id: "alice",
      project_id: "api",
      namespace_id: "project/api",
      title: "Client generation",
      body: "Regenerate the Java client before deployment.",
    });
    const otherBranch = vault.propose({
      tenant_id: "acme",
      owner_id: "alice",
      project_id: "api",
      namespace_id: "project/api",
      title: "Experimental client generation",
      body: "Use the experimental generator only on feature/new-generator.",
      branch: "feature/new-generator",
    });
    vault.commit(seed.record.id);
    vault.commit(related.record.id);
    vault.commit(otherBranch.record.id);
    vault.linkMemories({
      tenant_id: "acme",
      source_memory_id: seed.record.id,
      target_memory_id: related.record.id,
      relation: "requires",
      provenance: "ADR-42",
    });
    vault.linkMemories({
      tenant_id: "acme",
      source_memory_id: seed.record.id,
      target_memory_id: otherBranch.record.id,
      relation: "experimental-alternative",
      provenance: "branch experiment",
    });
    const results = vault.search({
      tenant_id: "acme",
      owner_id: "alice",
      query: "SchemaV2",
      project_id: "api",
      allowed_projects: ["api"],
      as_of: "2026-06-01T00:00:00Z",
      top_k: 5,
    });
    assert.deepEqual(new Set(results.map((item) => item.id)), new Set([seed.record.id, related.record.id]));
    assert.equal(results.find((item) => item.id === related.record.id).score_signals.graph > 0, true);
    assert.equal(results.some((item) => item.id === otherBranch.record.id), false);

    const before = vault.search({
      tenant_id: "acme",
      owner_id: "alice",
      query: "SchemaV2",
      project_id: "api",
      allowed_projects: ["api"],
      as_of: "2025-12-01T00:00:00Z",
    });
    assert.equal(before.length, 0);
    assert.equal(vault.verifyAuditLog().valid, true);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("code graph seeds and paths enforce node and edge validity before traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-temporal-code-graph-"));
  const vault = new ContextVault(root);
  try {
    const source = {
      repo_path: "src/Caller.java", kind: "method", qualified_name: "com.acme.Caller.call",
      valid_from: "2026-01-01T00:00:00Z",
    };
    const target = {
      repo_path: "src/Target.java", kind: "method", qualified_name: "com.acme.Target.run",
      valid_from: "2026-01-01T00:00:00Z",
    };
    vault.publishGraph({
      tenant_id: "acme", project_id: "api", branch: "main", commit: "abc", extractor_version: "test-v1",
      source_states: [
        { repo_path: source.repo_path, git_object_id: "caller" },
        { repo_path: target.repo_path, git_object_id: "target" },
      ],
      nodes: [source, target],
      edges: [{
        source, target, relation: "calls", repo_path: source.repo_path,
        valid_from: "2026-03-01T00:00:00Z", valid_to: "2026-09-01T00:00:00Z",
      }],
    });
    const input = {
      tenant_id: "acme", project_id: "api", allowed_projects: ["api"], branch: "main",
      query: "com.acme.Target.run", retrieval_mode: "graph-only", direction: "incoming",
    };
    assert.equal(vault.searchDetailed({ ...input, as_of: "2025-12-01T00:00:00Z" }).results.length, 0);
    const active = vault.searchDetailed({ ...input, as_of: "2026-06-01T00:00:00Z" }).results;
    assert.ok(active.some((result) => result.citation.symbol === "com.acme.Caller.call"));
    const expired = vault.searchDetailed({ ...input, as_of: "2026-10-01T00:00:00Z" }).results;
    assert.equal(expired.some((result) => result.citation.symbol === "com.acme.Caller.call"), false);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical graph scope evaluates project-edge valid_from and valid_to at as_of", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-temporal-project-edge-"));
  const vault = new ContextVault(root);
  try {
    const schema = { repo_path: "schema/OrderSchema.json", kind: "schema", qualified_name: "orders.OrderSchema" };
    vault.publishGraph({
      project_id: "orders-schema", branch: "main", commit: "schema", extractor_version: "test-v1",
      source_states: [{ repo_path: schema.repo_path, git_object_id: "schema" }], nodes: [schema], edges: [],
    });
    vault.linkProjects({
      source_project: "orders-api", target_project: "orders-schema", provenance: "historical pom.xml",
      valid_from: "2026-03-01T00:00:00Z", valid_to: "2026-09-01T00:00:00Z",
    });
    const input = {
      query: "orders.OrderSchema", project_id: "orders-api",
      allowed_projects: ["orders-api", "orders-schema"], branch: "main", retrieval_mode: "graph-only",
    };
    assert.equal(vault.searchDetailed({ ...input, as_of: "2026-02-01T00:00:00Z" }).results.length, 0);
    assert.equal(vault.searchDetailed({ ...input, as_of: "2026-06-01T00:00:00Z" }).results.length, 1);
    assert.equal(vault.searchDetailed({ ...input, as_of: "2026-10-01T00:00:00Z" }).results.length, 0);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
