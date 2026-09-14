import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HybridEngine } from "../src/embeddings.js";
import { ContextVault, estimateSerializedTokens } from "../src/store.js";

function publishOrderGraph(vault) {
  const controller = {
    repo_path: "src/main/java/com/acme/OrderController.java",
    kind: "class",
    qualified_name: "com.acme.OrderController",
    label: "OrderController",
    language: "java",
  };
  return vault.publishGraph({
    project_id: "orders",
    branch: "main",
    commit: "abc123",
    extractor_version: "test-v1",
    source_states: [{ repo_path: controller.repo_path, git_object_id: "controller-v1" }],
    nodes: [controller],
    edges: [],
  });
}

function countingEmbedder(vector = [1, 0, 0, 0, 0, 0, 0, 0]) {
  return {
    id: "fixture:counting",
    queryCalls: 0,
    async embedQuery() {
      this.queryCalls += 1;
      return vector;
    },
    async embedDocuments(texts) { return texts.map(() => vector); },
  };
}

test("graph-first embeds at most once and only when graph coverage requests fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-first-test-"));
  const vault = new ContextVault(root);
  const embedder = countingEmbedder();
  try {
    publishOrderGraph(vault);
    const semantic = vault.propose({
      project_id: "orders",
      namespace_id: "project/orders",
      title: "Checkout consistency",
      body: "Use an outbox when coordinating state across service boundaries.",
    });
    vault.commit(semantic.record.id);
    const engine = new HybridEngine(vault, embedder);
    await engine.indexMemory(semantic.record.id);

    const exact = await engine.searchDetailed({
      query: "OrderController",
      project_id: "orders",
      allowed_projects: ["orders"],
      branch: "main",
      retrieval_mode: "graph-first",
    });
    assert.equal(embedder.queryCalls, 0);
    assert.equal(exact.retrieval.semantic_fallback_used, false);
    assert.equal(exact.retrieval.fallback_reason, null);

    const conceptual = await engine.searchDetailed({
      query: "how should distributed checkout writes stay consistent",
      project_id: "orders",
      allowed_projects: ["orders"],
      branch: "main",
      retrieval_mode: "graph-first",
    });
    assert.equal(embedder.queryCalls, 1);
    assert.equal(conceptual.retrieval.semantic_fallback_used, true);
    assert.ok(["no_seed", "insufficient_candidates", "low_path_confidence", "conceptual_query"]
      .includes(conceptual.retrieval.fallback_reason));
    assert.equal(conceptual.results.some((item) => item.id === semantic.record.id), true);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph-only never embeds, while legacy hybrid eagerly includes semantic candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-retrieval-modes-test-"));
  const vault = new ContextVault(root);
  const embedder = countingEmbedder();
  try {
    const semantic = vault.propose({
      project_id: "orders",
      namespace_id: "project/orders",
      title: "Reliable publication",
      body: "Use a transactional outbox for cross-system publication.",
    });
    vault.commit(semantic.record.id);
    const engine = new HybridEngine(vault, embedder);
    await engine.indexMemory(semantic.record.id);

    const graphOnly = await engine.searchDetailed({
      query: "avoid inconsistent dual writes",
      project_id: "orders",
      allowed_projects: ["orders"],
      retrieval_mode: "graph-only",
    });
    assert.equal(embedder.queryCalls, 0);
    assert.equal(graphOnly.retrieval.semantic_fallback_used, false);

    const hybrid = await engine.searchDetailed({
      query: "avoid inconsistent dual writes",
      project_id: "orders",
      allowed_projects: ["orders"],
      retrieval_mode: "hybrid",
    });
    assert.equal(embedder.queryCalls, 1);
    assert.equal(hybrid.results[0].id, semantic.record.id);
    assert.equal(hybrid.retrieval.semantic_fallback_used, false);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("context packs expose actual graph, fallback, hybrid, and unavailable retrieval telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-context-pack-modes-"));
  const vault = new ContextVault(root);
  const embedder = countingEmbedder();
  try {
    publishOrderGraph(vault);
    const engine = new HybridEngine(vault, embedder);
    const common = {
      project_id: "orders",
      allowed_projects: ["orders"],
      branch: "main",
      token_budget: 1200,
    };

    const graphOnly = await engine.contextPack({ ...common, task: "OrderController", retrieval_mode: "graph-only" });
    assert.equal(graphOnly.retrieval_mode, "graph-only");
    assert.equal(graphOnly.retrieval.requested_mode, "graph-only");
    assert.equal(graphOnly.retrieval.semantic_fallback_used, false);
    assert.equal(embedder.queryCalls, 0);

    const graphFirst = await engine.contextPack({ ...common, task: "OrderController", retrieval_mode: "graph-first" });
    assert.equal(graphFirst.retrieval_mode, "graph-first");
    assert.equal(graphFirst.retrieval.effective_mode, "graph-first");
    assert.equal(graphFirst.retrieval.semantic_fallback_used, false);
    assert.equal(embedder.queryCalls, 0);

    const fallback = await engine.contextPack({
      ...common,
      task: "where should unknown distributed responsibilities be implemented",
      retrieval_mode: "graph-first",
    });
    assert.equal(fallback.retrieval_mode, "hybrid");
    assert.equal(fallback.retrieval.requested_mode, "graph-first");
    assert.equal(fallback.retrieval.semantic_fallback_used, true);
    assert.ok(["no_seed", "insufficient_candidates", "low_path_confidence", "conceptual_query"]
      .includes(fallback.retrieval.fallback_reason));
    assert.equal(embedder.queryCalls, 1);

    const hybrid = await engine.contextPack({ ...common, task: "OrderController", retrieval_mode: "hybrid" });
    assert.equal(hybrid.retrieval_mode, "hybrid");
    assert.equal(hybrid.retrieval.requested_mode, "hybrid");
    assert.equal(hybrid.retrieval.semantic_fallback_used, false);
    assert.equal(embedder.queryCalls, 2);

    const unavailable = await new HybridEngine(vault).contextPack({
      ...common,
      task: "where should unknown distributed responsibilities be implemented",
      retrieval_mode: "graph-first",
      branch: "missing",
    });
    assert.equal(unavailable.retrieval_mode, "lexical+graph");
    assert.equal(unavailable.retrieval.semantic_fallback_used, false);
    assert.equal(unavailable.retrieval.fallback_reason, "semantic_unavailable");

    const hybridUnavailable = await new HybridEngine(vault).contextPack({
      ...common,
      task: "OrderController",
      retrieval_mode: "hybrid",
    });
    assert.equal(hybridUnavailable.retrieval_mode, "lexical+graph");
    assert.equal(hybridUnavailable.retrieval.requested_mode, "hybrid");
    assert.equal(hybridUnavailable.retrieval.semantic_fallback_used, false);
    assert.equal(hybridUnavailable.retrieval.fallback_reason, null);

    const tiny = await engine.contextPack({ ...common, task: "OrderController", retrieval_mode: "graph-only", token_budget: 64 });
    assert.ok(estimateSerializedTokens(tiny) <= 64, JSON.stringify(tiny));
    const tinyUnavailable = await new HybridEngine(vault).contextPack({
      ...common,
      task: "unknown responsibility",
      retrieval_mode: "graph-first",
      branch: "missing",
      token_budget: 64,
    });
    assert.ok(estimateSerializedTokens(tinyUnavailable) <= 64, JSON.stringify(tinyUnavailable));
    assert.equal(tinyUnavailable.retrieval.effective_mode, "lexical+graph");
    assert.equal(tinyUnavailable.retrieval.fallback_reason, "semantic_unavailable");
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unauthorized or stale graphs cannot suppress fallback and unavailable semantics are truthful", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-fallback-scope-test-"));
  const vault = new ContextVault(root);
  const embedder = countingEmbedder();
  try {
    publishOrderGraph(vault);
    const engine = new HybridEngine(vault, embedder);
    const stale = await engine.searchDetailed({
      query: "OrderController",
      project_id: "orders",
      allowed_projects: ["orders"],
      branch: "feature/missing",
      retrieval_mode: "graph-first",
    });
    assert.equal(embedder.queryCalls, 1);
    assert.equal(stale.retrieval.semantic_fallback_used, true);
    assert.equal(stale.retrieval.fallback_reason, "no_seed");

    const unavailable = await new HybridEngine(vault).searchDetailed({
      query: "where is an unknown conceptual responsibility implemented",
      project_id: "orders",
      allowed_projects: ["orders"],
      branch: "feature/missing",
      retrieval_mode: "graph-first",
    });
    assert.equal(unavailable.retrieval.semantic_fallback_used, false);
    assert.equal(unavailable.retrieval.fallback_reason, "semantic_unavailable");

    const legacyWithoutEmbedder = await new HybridEngine(vault).searchDetailed({
      query: "unknown legacy query",
      project_id: "orders",
      allowed_projects: ["orders"],
      retrieval_mode: "hybrid",
    });
    assert.equal(legacyWithoutEmbedder.retrieval.effective_mode, "lexical+graph");
    assert.equal(legacyWithoutEmbedder.retrieval.semantic_fallback_used, false);
    assert.equal(legacyWithoutEmbedder.retrieval.fallback_reason, null);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("hybrid retrieval excludes historical handoffs before semantic fusion", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-embedding-handoff-test-"));
  const vault = new ContextVault(root);
  const embedder = {
    id: "fixture:handoff-exclusion",
    async embedDocuments(texts) { return texts.map(() => [0, 1, 0, 0, 0, 0, 0, 0]); },
    async embedQuery() { return [0, 1, 0, 0, 0, 0, 0, 0]; },
  };
  try {
    const saved = vault.saveHandoff({
      tenant_id: "local",
      owner_id: "local-user",
      agent_id: "agent-a",
      project_id: "api",
      task_id: "old-task",
      goal: "Retire an obsolete migration",
      current_state: "Delete the legacy database",
      checkpoint_id: "old-checkpoint",
      branch: "main",
    }, {
      assessment: {
        disposition: "active",
        reason: "test policy",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    });
    const engine = new HybridEngine(vault, embedder);
    await engine.indexMemory(saved.record.id);

    const visible = await engine.search({
      query: "What should I do next?",
      project_id: "api",
      allowed_projects: ["api"],
      branch: "main",
    });
    assert.equal(visible[0].id, saved.record.id);

    const excluded = await engine.search({
      query: "What should I do next?",
      project_id: "api",
      allowed_projects: ["api"],
      branch: "main",
      exclude_types: ["handoff"],
    });
    assert.equal(excluded.length, 0);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
