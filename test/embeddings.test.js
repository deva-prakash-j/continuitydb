import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HybridEngine } from "../src/embeddings.js";
import { ContextVault } from "../src/store.js";

test("hybrid engine returns ACL-filtered semantic candidates when lexical search has no hit", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-embedding-test-"));
  const vault = new ContextVault(root);
  const vectors = new Map();
  const embedder = {
    id: "fixture:model",
    async embed(input) {
      const texts = Array.isArray(input) ? input : [input];
      return texts.map((text) => vectors.get(text) || [1, 0, 0, 0, 0, 0, 0, 0]);
    },
  };
  try {
    const proposal = vault.propose({
      project_id: "billing",
      namespace_id: "project/billing",
      title: "Outbox relay",
      body: "Persist the invoice and publication record atomically, then relay later.",
      branch: "feature/outbox",
    });
    vault.commit(proposal.record.id);
    vectors.set(`${proposal.record.title}\n${proposal.record.body}`, [0, 1, 0, 0, 0, 0, 0, 0]);
    vectors.set("avoid inconsistent dual writes", [0, 1, 0, 0, 0, 0, 0, 0]);
    const engine = new HybridEngine(vault, embedder);
    await engine.indexMemory(proposal.record.id);
    const results = await engine.search({
      query: "avoid inconsistent dual writes",
      project_id: "billing",
      allowed_projects: ["billing"],
      branch: "feature/outbox",
    });
    assert.equal(results[0].id, proposal.record.id);
    assert.ok(results[0].score_signals.semantic > 0);

    const wrongBranch = await engine.search({
      query: "avoid inconsistent dual writes",
      project_id: "billing",
      allowed_projects: ["billing"],
      branch: "main",
    });
    assert.equal(wrongBranch.length, 0);

    const denied = await engine.search({
      query: "avoid inconsistent dual writes",
      project_id: "other",
      allowed_projects: ["other"],
    });
    assert.equal(denied.length, 0);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hybrid indexing batches active memories that do not have the current model projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-embedding-batch-test-"));
  const vault = new ContextVault(root);
  const embedder = {
    id: "fixture:batch-v1",
    async embedDocuments(texts) { return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]); },
    async embedQuery() { return [1, 0, 0, 0, 0, 0, 0, 0]; },
  };
  try {
    for (const body of ["First semantic fact", "Second semantic fact"]) {
      const proposal = vault.propose({ tenant_id: "local", owner_id: "local-user", namespace_id: "project/api", project_id: "api", body });
      vault.commit(proposal.record.id);
    }
    const engine = new HybridEngine(vault, embedder);
    assert.equal((await engine.indexPending()).indexed, 2);
    assert.equal((await engine.indexPending()).indexed, 0);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
