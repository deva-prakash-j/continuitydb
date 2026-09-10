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
