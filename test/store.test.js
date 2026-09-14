import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ContextVault, estimateSerializedTokens } from "../src/store.js";

const firstOpenScript = `
  import { ContextVault } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
  const [root, startAtValue] = process.argv.slice(1);
  const startAt = Number(startAtValue);
  while (Date.now() < startAt) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const vault = new ContextVault(root);
  try {
    const result = vault.verifyAuditLog();
    process.stdout.write(JSON.stringify({ ok: true, audit_valid: result.valid }));
  } finally { vault.close(); }
`;

const concurrentApprovalScript = `
  import { ContextVault } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
  const [root, memoryId, startAtValue] = process.argv.slice(1);
  const vault = new ContextVault(root);
  try {
    const startAt = Number(startAtValue);
    while (Date.now() < startAt) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const result = vault.approve(memoryId, { actor: \`reviewer/\${memoryId}\` });
    process.stdout.write(JSON.stringify({ ok: true, id: result.id }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, statusCode: error.statusCode || null, message: error.message }));
  } finally { vault.close(); }
`;

function runFirstOpen(root, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module", "--eval", firstOpenScript, root, String(startAt),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("concurrent first-open process exceeded 20 second timeout"));
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`first-open process exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`first-open process returned invalid JSON: ${stdout}\n${stderr}`)); }
    });
  });
}

function runConcurrentApproval(root, memoryId, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module", "--eval", concurrentApprovalScript, root, memoryId, String(startAt),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("concurrent approval process exceeded 20 second timeout"));
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`approval process exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`approval process returned invalid JSON: ${stdout}\n${stderr}`)); }
    });
  });
}

const ACTIVE_HANDOFF = Object.freeze({
  disposition: "active",
  reason: "test policy",
  expires_at: "2099-01-01T00:00:00.000Z",
});

function auditEvent(input) {
  const base = { ...input };
  return { ...base, event_hash: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "context-vault-test-"));
  const vault = new ContextVault(root);
  return {
    root,
    vault,
    cleanup() {
      vault.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function graphFixture({ commit, danglingEdge = false } = {}) {
  const source = {
    repo_path: "src/main/java/com/acme/Api.java",
    kind: "class",
    qualified_name: "com.acme.Api",
    language: "java",
  };
  const target = {
    repo_path: "src/main/java/com/acme/Service.java",
    kind: "class",
    qualified_name: "com.acme.Service",
    language: "java",
  };
  return {
    project_id: "api",
    branch: "main",
    commit,
    extractor_version: "graph-v1",
    source_states: [
      { repo_path: source.repo_path, git_object_id: `${commit}-api`, extractor_version: "graph-v1" },
      { repo_path: target.repo_path, git_object_id: `${commit}-service`, extractor_version: "graph-v1" },
    ],
    nodes: [source, target],
    edges: [{
      source,
      target: danglingEdge ? { ...target, qualified_name: "com.acme.Missing" } : target,
      relation: "calls",
      repo_path: source.repo_path,
      start_line: 18,
      provenance: "resolved",
    }],
  };
}

test("publishing a graph atomically supersedes the previous generation", () => {
  const f = fixture();
  try {
    const first = f.vault.publishGraph(graphFixture({ commit: "a" }));
    const second = f.vault.publishGraph(graphFixture({ commit: "b" }));
    assert.equal(f.vault.activeGraphGeneration({ project_id: "api" }).id, second.id);
    assert.equal(f.vault.graphStatus({ project_id: "api" }).generations.superseded, 1);
    assert.notEqual(first.id, second.id);
    assert.equal(f.vault.graphStatus({ project_id: "api" }).nodes, 2);
    assert.equal(f.vault.verifyAuditLog().valid, true);
  } finally { f.cleanup(); }
});

test("active graph projection exposes only the scoped active generation", () => {
  const f = fixture();
  try {
    const first = f.vault.publishGraph(graphFixture({ commit: "a" }));
    const projection = f.vault.activeGraphProjection({ project_id: "api", branch: "main" });
    assert.equal(projection.generation.id, first.id);
    assert.equal(projection.source_states.length, 2);
    assert.equal(projection.nodes.length, 2);
    assert.equal(projection.edges.length, 1);
    assert.deepEqual(f.vault.activeGraphProjection({ project_id: "other", branch: "main" }), {
      generation: null, source_states: [], nodes: [], edges: [],
    });
  } finally { f.cleanup(); }
});

test("detailed graph search preserves the legacy array search contract", () => {
  const f = fixture();
  try {
    const generation = f.vault.publishGraph(graphFixture({ commit: "a" }));
    const input = {
      query: "com.acme.Api",
      project_id: "api",
      allowed_projects: ["api"],
      branch: "main",
      retrieval_mode: "graph-only",
    };
    const detailed = f.vault.searchDetailed(input);
    assert.equal(detailed.retrieval.graph_generation.id, generation.id);
    assert.ok(detailed.results.some((result) => result.citation.symbol === "com.acme.Api"));
    assert.deepEqual(f.vault.search(input), detailed.results);
  } finally { f.cleanup(); }
});

test("detailed search packs retrieval metadata and cited paths inside the token envelope", () => {
  const f = fixture();
  try {
    f.vault.publishGraph(graphFixture({ commit: "budget" }));
    const detailed = f.vault.searchDetailed({
      query: "com.acme.Service",
      project_id: "api",
      allowed_projects: ["api"],
      branch: "main",
      retrieval_mode: "graph-only",
      direction: "incoming",
      top_k: 2,
      token_budget: 475,
    });
    assert.ok(estimateSerializedTokens(detailed) <= 475);
    assert.ok(detailed.results.some((result) => result.graph_path.length === 1));
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

test("graph publication rejects a scope that graph reads cannot address", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.vault.publishGraph({ ...graphFixture({ commit: "a" }), project_id: "api team" }),
      /project_id contains invalid characters or length/,
    );
    const published = f.vault.publishGraph(graphFixture({ commit: "b" }));
    assert.equal(f.vault.activeGraphGeneration({ project_id: "api" }).id, published.id);
  } finally { f.cleanup(); }
});

test("concurrent processes can initialize the same empty vault", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-first-open-test-"));
  try {
    const startAt = Date.now() + 500;
    const results = await Promise.all(Array.from({ length: 24 }, () => runFirstOpen(root, startAt)));
    assert.equal(results.length, 24);
    assert.ok(results.every((result) => result.ok && result.audit_valid));

    const reopened = new ContextVault(root);
    assert.equal(reopened.verifyAuditLog().valid, true);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals are invisible until committed and retries are idempotent", () => {
  const f = fixture();
  try {
    const first = f.vault.propose({
      body: "The billing service uses the outbox pattern for Kafka publication.",
      namespace_id: "project/billing-service",
      project_id: "billing-service",
      idempotency_key: "billing-outbox-v1",
    });
    assert.equal(f.vault.search({
      query: "Kafka outbox",
      project_id: "billing-service",
      allowed_projects: ["billing-service"],
    }).length, 0);

    const retry = f.vault.propose({
      body: "This retry body must not create another memory.",
      namespace_id: "project/billing-service",
      idempotency_key: "billing-outbox-v1",
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.record.id, first.record.id);

    const otherProject = f.vault.propose({
      body: "The same client key can be reused safely in another project namespace.",
      namespace_id: "project/schema-service",
      project_id: "schema-service",
      idempotency_key: "billing-outbox-v1",
    });
    assert.equal(otherProject.duplicate, false);
    assert.notEqual(otherProject.record.id, first.record.id);

    f.vault.commit(first.record.id);
    const results = f.vault.search({
      query: "Kafka outbox",
      project_id: "billing-service",
      allowed_projects: ["billing-service"],
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, first.record.id);
  } finally {
    f.cleanup();
  }
});

test("a project sees explicit dependencies but not unrelated projects", () => {
  const f = fixture();
  try {
    const shared = f.vault.propose({
      body: "Changing ChargeSchema requires regenerating downstream Java clients.",
      namespace_id: "project/charge-schema",
      project_id: "charge-schema",
      symbol: "ChargeSchema",
      git_commit: "abc123",
    });
    f.vault.commit(shared.record.id);

    const unrelated = f.vault.propose({
      body: "ChargeSchema is mentioned in an unrelated sandbox.",
      namespace_id: "project/sandbox",
      project_id: "sandbox",
    });
    f.vault.commit(unrelated.record.id);

    f.vault.linkProjects({
      source_project: "charge-api",
      target_project: "charge-schema",
      provenance: "charge-api/pom.xml declares charge-schema",
    });

    const results = f.vault.search({
      query: "ChargeSchema",
      project_id: "charge-api",
      allowed_projects: ["charge-api", "charge-schema"],
    });
    assert.deepEqual(results.map((item) => item.id), [shared.record.id]);
  } finally {
    f.cleanup();
  }
});

test("forget removes a memory from recall and canonical data rebuilds the index", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      body: "Run ./gradlew contractTest before publishing the shared client.",
      namespace_id: "personal/global",
    });
    f.vault.commit(proposal.record.id);
    assert.equal(f.vault.search({ query: "contractTest" }).length, 1);

    assert.equal(f.vault.rebuildIndex().records, 1);
    assert.equal(f.vault.search({ query: "contractTest" }).length, 1);

    const forgotten = f.vault.forget(proposal.record.id);
    assert.equal(forgotten.recoverable, true);
    assert.equal(f.vault.search({ query: "contractTest" }).length, 0);
  } finally {
    f.cleanup();
  }
});

test("owner, sensitivity and project allowlists are enforced before retrieval", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      owner_id: "office-user",
      body: "InternalLedger rotates signing material through the corporate key service.",
      namespace_id: "project/ledger-private",
      project_id: "ledger-private",
      sensitivity: "sensitive",
    });
    f.vault.commit(proposal.record.id);

    assert.throws(
      () => f.vault.search({
        query: "InternalLedger",
        project_id: "ledger-private",
        owner_id: "local-user",
        allowed_projects: [],
      }),
      /not allowed/,
    );
    assert.equal(f.vault.search({
      query: "InternalLedger",
      project_id: "ledger-private",
      owner_id: "local-user",
      allowed_projects: ["ledger-private"],
      allowed_sensitivities: ["public", "private", "sensitive"],
    }).length, 0);
    assert.equal(f.vault.search({
      query: "InternalLedger",
      project_id: "ledger-private",
      owner_id: "office-user",
      allowed_projects: ["ledger-private"],
      allowed_sensitivities: ["public", "private"],
    }).length, 0);
    assert.equal(f.vault.search({
      query: "InternalLedger",
      project_id: "ledger-private",
      owner_id: "office-user",
      allowed_projects: ["ledger-private"],
      allowed_sensitivities: ["sensitive"],
    }).length, 1);
  } finally {
    f.cleanup();
  }
});

test("credential-like content is rejected before canonical or indexed storage", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.vault.propose({ body: `api_key=${"sk-"}${"x".repeat(32)}` }),
      /credential-like content is prohibited/,
    );
    assert.equal(f.vault.exportJsonl(), "");
  } finally {
    f.cleanup();
  }
});

test("same-body corrections create a new active version and supersede the old one", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      body: "Use Java 21 for new platform services.",
      namespace_id: "personal/global",
      confidence: 0.7,
    });
    f.vault.commit(proposal.record.id);
    const corrected = f.vault.correct(proposal.record.id, {
      body: "Use Java 21 for new platform services.",
      confidence: 1,
    }, "confidence-confirmed");

    assert.notEqual(corrected.id, proposal.record.id);
    assert.equal(corrected.status, "active");
    assert.equal(f.vault.get(proposal.record.id, { includeInactive: true }).status, "superseded");
    const results = f.vault.search({ query: "Java 21 platform services" });
    assert.deepEqual(results.map((item) => item.id), [corrected.id]);
  } finally {
    f.cleanup();
  }
});

test("v0.2 SQLite schema upgrades before subject indexes are created", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-upgrade-test-"));
  try {
    const initial = new ContextVault(root);
    initial.close();
    const database = new DatabaseSync(join(root, "index", "context-vault.db"));
    database.exec("DROP INDEX IF EXISTS idx_memory_subject; ALTER TABLE memory_records DROP COLUMN subject_key;");
    database.close();

    const upgraded = new ContextVault(root);
    const columns = upgraded.db.prepare("PRAGMA table_info(memory_records)").all().map((row) => row.name);
    assert.equal(columns.includes("subject_key"), true);
    const indexes = upgraded.db.prepare("PRAGMA index_list(memory_records)").all().map((row) => row.name);
    assert.equal(indexes.includes("idx_memory_subject"), true);
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("branch-scoped memory never leaks into an unspecified or different branch", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      body: "FeatureBranchOnly uses the new contract.",
      namespace_id: "project/api",
      project_id: "api",
      branch: "feature/schema-v2",
    });
    f.vault.commit(proposal.record.id);
    const input = {
      query: "FeatureBranchOnly",
      project_id: "api",
      allowed_projects: ["api"],
    };
    assert.equal(f.vault.search(input).length, 0);
    assert.equal(f.vault.search({ ...input, branch: "main" }).length, 0);
    assert.equal(f.vault.search({ ...input, branch: "feature/schema-v2" }).length, 1);
  } finally {
    f.cleanup();
  }
});

test("token budgets include titles, citations and serialized response structure", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      title: "Long citation fixture ".repeat(8),
      body: "BudgetedMemory ".repeat(1000),
      namespace_id: "project/api",
      project_id: "api",
      source_uri: `git://api/${"a".repeat(300)}`,
      repo_path: `src/${"nested/".repeat(20)}ApiClient.java`,
    });
    f.vault.commit(proposal.record.id);
    const results = f.vault.search({
      query: "BudgetedMemory",
      project_id: "api",
      allowed_projects: ["api"],
      token_budget: 300,
    });
    assert.ok(results[0].body.length < proposal.record.body.length);
    assert.ok(estimateSerializedTokens({ results }) <= 300);
    const pack = f.vault.contextPack({
      task: "BudgetedMemory",
      project_id: "api",
      allowed_projects: ["api"],
      token_budget: 300,
    });
    assert.ok(estimateSerializedTokens(pack) <= 300);
    assert.equal(pack.budget.requested_tokens, 300);
    assert.equal(pack.budget.estimated_tokens, estimateSerializedTokens(pack));
    const tinyPack = f.vault.contextPack({
      task: "x".repeat(10_000),
      project_id: "api",
      allowed_projects: ["api"],
      token_budget: 64,
    });
    assert.ok(estimateSerializedTokens(tinyPack) <= 64);
  } finally {
    f.cleanup();
  }
});

test("structured handoffs return the latest checkpoint for the applicable branch", () => {
  const f = fixture();
  try {
    const shared = {
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      principal_id: "principal-a",
      project_id: "api",
      task_id: "schema-v2",
      goal: "Roll out SchemaV2",
      current_state: "Started",
    };
    f.vault.saveHandoff({ ...shared, branch: "main", checkpoint_id: "main-1" }, { assessment: ACTIVE_HANDOFF });
    f.vault.saveHandoff({
      ...shared,
      branch: "feature/schema-v2",
      checkpoint_id: "feature-1",
      current_state: "Client regenerated",
      completed_work: ["Generated client"],
      next_actions: ["Run contract tests"],
    }, { assessment: ACTIVE_HANDOFF });
    const latest = f.vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "schema-v2",
      branch: "feature/schema-v2",
      allowed_sensitivities: ["private"],
    });
    assert.equal(latest.handoff.current_state, "Client regenerated");
    assert.deepEqual(latest.handoff.next_actions, ["Run contract tests"]);
    assert.equal(f.vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "schema-v2",
      branch: "other",
      allowed_sensitivities: ["private"],
    }), null);
  } finally {
    f.cleanup();
  }
});

test("handoffs require policy assessment and scope checkpoint idempotency by task and branch", () => {
  const f = fixture();
  try {
    const shared = {
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      project_id: "api",
      goal: "Continue rollout",
      current_state: "Started",
      checkpoint_id: "checkpoint-1",
    };
    assert.throws(() => f.vault.saveHandoff({ ...shared, task_id: "task-a" }), /assessment is required/);
    assert.throws(() => f.vault.saveHandoff({
      ...shared,
      task_id: "sensitive-task",
      sensitivity: "sensitive",
    }, { assessment: ACTIVE_HANDOFF }), /high-sensitivity handoff cannot activate/);
    const first = f.vault.saveHandoff({ ...shared, task_id: "task-a", branch: "main" }, { assessment: ACTIVE_HANDOFF });
    const otherTask = f.vault.saveHandoff({ ...shared, task_id: "task-b", branch: "main" }, { assessment: ACTIVE_HANDOFF });
    const otherBranch = f.vault.saveHandoff({ ...shared, task_id: "task-a", branch: "feature" }, { assessment: ACTIVE_HANDOFF });
    assert.notEqual(first.record.id, otherTask.record.id);
    assert.notEqual(first.record.id, otherBranch.record.id);

    const retry = f.vault.saveHandoff({ ...shared, task_id: "task-a", branch: "main" }, { assessment: ACTIVE_HANDOFF });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.record.id, first.record.id);
    assert.deepEqual(retry.handoff, first.handoff);
    assert.throws(() => f.vault.saveHandoff({
      ...shared,
      task_id: "task-a",
      branch: "main",
      current_state: "Unsaved conflicting response",
    }, { assessment: ACTIVE_HANDOFF }), /already used with different handoff data/);
  } finally {
    f.cleanup();
  }
});

test("latest handoff uses a monotonic checkpoint sequence when timestamps tie", () => {
  const f = fixture();
  try {
    const shared = {
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      project_id: "api",
      task_id: "same-millisecond",
      goal: "Resume deterministically",
      branch: "main",
    };
    const first = f.vault.saveHandoff({ ...shared, checkpoint_id: "first", current_state: "Earlier" }, { assessment: ACTIVE_HANDOFF });
    const second = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "second",
      previous_checkpoint_id: "first",
      current_state: "Later",
    }, { assessment: ACTIVE_HANDOFF });
    f.vault.db.prepare("UPDATE memory_records SET updated_at = ? WHERE id IN (?, ?)")
      .run("2026-01-01T00:00:00.000Z", first.record.id, second.record.id);
    const latest = f.vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "same-millisecond",
      branch: "main",
      allowed_sensitivities: ["private"],
    });
    assert.ok(second.record.handoff_sequence > first.record.handoff_sequence);
    assert.equal(latest.record.id, second.record.id);
    assert.equal(latest.handoff.current_state, "Later");
    assert.equal(f.vault.get(first.record.id, { includeInactive: true }).status, "superseded");
  } finally {
    f.cleanup();
  }
});

test("stale or missing handoff lineage is quarantined and cannot replace latest context", () => {
  const f = fixture();
  try {
    const shared = {
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      project_id: "api",
      task_id: "conflicting-rollout",
      goal: "Roll out safely",
      branch: "main",
    };
    const first = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "checkpoint-1",
      current_state: "Schema first",
    }, { assessment: ACTIVE_HANDOFF });
    const conflict = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "checkpoint-2",
      current_state: "API first",
    }, { assessment: ACTIVE_HANDOFF });
    assert.equal(first.disposition, "active");
    assert.equal(conflict.disposition, "quarantined");
    assert.match(conflict.reason, /lineage conflict/);
    assert.equal(f.vault.get(conflict.record.id), null);
    const latest = f.vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "conflicting-rollout",
      branch: "main",
      allowed_sensitivities: ["private"],
    });
    assert.equal(latest.record.id, first.record.id);
    assert.equal(latest.handoff.current_state, "Schema first");
  } finally {
    f.cleanup();
  }
});

test("handoff correction preserves task identity and rebuilds structured and rendered state", () => {
  const f = fixture();
  try {
    const saved = f.vault.saveHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      project_id: "api",
      task_id: "correct-me",
      checkpoint_id: "checkpoint-1",
      goal: "Finish the migration",
      current_state: "Old state",
      branch: "main",
    }, { assessment: ACTIVE_HANDOFF });
    assert.throws(() => f.vault.correct(saved.record.id, { body: "Raw replacement" }, "unsafe correction"), /replacement\.handoff/);
    const corrected = f.vault.correct(saved.record.id, {
      handoff: {
        current_state: "Corrected state",
        completed_work: ["Migration complete"],
        next_actions: ["Run verification"],
      },
    }, "fix checkpoint state");
    const metadata = JSON.parse(corrected.metadata_json);
    assert.equal(corrected.subject_key, saved.record.subject_key);
    assert.equal(metadata.handoff.task_id, "correct-me");
    assert.equal(metadata.handoff.checkpoint_id, "checkpoint-1");
    assert.equal(metadata.handoff.current_state, "Corrected state");
    assert.match(corrected.body, /Current state: Corrected state/);
    assert.match(corrected.body, /Migration complete/);
    const latest = f.vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "correct-me",
      branch: "main",
      allowed_sensitivities: ["private"],
    });
    assert.equal(latest.record.id, corrected.id);
  } finally {
    f.cleanup();
  }
});

test("held handoff review also requires structured correction", () => {
  const f = fixture();
  try {
    const saved = f.vault.saveHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      project_id: "api",
      task_id: "review-me",
      checkpoint_id: "checkpoint-1",
      goal: "Review sensitive state",
      current_state: "Needs correction",
      sensitivity: "sensitive",
    }, {
      assessment: {
        disposition: "quarantined",
        reason: "high-sensitivity handoff requires review",
        expires_at: null,
      },
    });
    assert.equal(saved.record.status, "quarantined");
    assert.throws(() => f.vault.revisePending(
      saved.record.id,
      { body: "Raw inconsistent correction" },
      "review",
    ), /replacement\.handoff/);
    const revised = f.vault.revisePending(saved.record.id, {
      handoff: { current_state: "Corrected before approval" },
    }, "review");
    assert.equal(revised.status, "proposed");
    assert.equal(JSON.parse(revised.metadata_json).handoff.current_state, "Corrected before approval");
    assert.match(revised.body, /Current state: Corrected before approval/);
  } finally {
    f.cleanup();
  }
});

test("review approval atomically revalidates handoff lineage and applies bounded activation", () => {
  const f = fixture();
  const activeAssessment = {
    ...ACTIVE_HANDOFF,
    activation_ttl_seconds: 3_600,
    quota_limit: 10,
  };
  const heldAssessment = {
    disposition: "quarantined",
    reason: "high-sensitivity handoff requires review",
    expires_at: null,
    activation_ttl_seconds: 3_600,
    quota_limit: 10,
  };
  const shared = {
    tenant_id: "tenant-a",
    owner_id: "owner-a",
    agent_id: "agent-a",
    project_id: "api",
    task_id: "review-lineage",
    goal: "Approve only the current successor",
    branch: "main",
  };
  try {
    const first = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "checkpoint-1",
      current_state: "Initial active checkpoint",
    }, { assessment: activeAssessment });
    const validHeld = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "checkpoint-2",
      previous_checkpoint_id: "checkpoint-1",
      current_state: "Reviewed successor",
      sensitivity: "sensitive",
    }, { assessment: heldAssessment });
    const approved = f.vault.approve(validHeld.record.id, { actor: "reviewer-a" });
    assert.equal(approved.status, "active");
    assert.equal(approved.supersedes_id, first.record.id);
    assert.ok(Date.parse(approved.expires_at) > Date.now());
    assert.ok(Date.parse(approved.expires_at) <= Date.now() + 3_605_000);
    assert.equal(f.vault.get(first.record.id, { includeInactive: true }).status, "superseded");

    const staleHeld = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "checkpoint-3",
      previous_checkpoint_id: "checkpoint-2",
      current_state: "Held while another writer advances",
      sensitivity: "sensitive",
    }, { assessment: heldAssessment });
    const winner = f.vault.saveHandoff({
      ...shared,
      checkpoint_id: "checkpoint-4",
      previous_checkpoint_id: "checkpoint-2",
      current_state: "Concurrent winning successor",
    }, { assessment: activeAssessment });

    assert.throws(
      () => f.vault.approve(staleHeld.record.id, { actor: "reviewer-a" }),
      (error) => error.statusCode === 409 && /approval lineage conflict/.test(error.message),
    );
    assert.equal(f.vault.get(staleHeld.record.id, { includeInactive: true }).status, "quarantined");
    assert.equal(f.vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "review-lineage",
      branch: "main",
      allowed_sensitivities: ["private", "sensitive"],
    }).record.id, winner.record.id);
  } finally {
    f.cleanup();
  }
});

test("low-level commit and capture APIs cannot bypass handoff governance", () => {
  const f = fixture();
  try {
    const handoff = {
      task_id: "bypass-attempt",
      checkpoint_id: "checkpoint-1",
      goal: "Bypass policy",
      current_state: "Unreviewed",
      completed_work: [],
      unresolved_questions: [],
      next_actions: [],
      relevant_files: [],
      state: "in_progress",
      branch: "main",
      git_commit: null,
      previous_checkpoint_id: null,
    };
    const proposed = f.vault.propose({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      agent_id: "agent-a",
      namespace_id: "project/api",
      project_id: "api",
      type: "handoff",
      subject_key: "handoff:bypass-attempt",
      title: "Unsafe handoff",
      body: "Unreviewed handoff body",
      metadata: { handoff },
    });
    assert.throws(() => f.vault.commit(proposed.record.id), /must use saveHandoff or approve/);
    assert.throws(() => f.vault.capture({
      disposition: "active",
      reason: "forged assessment",
      record: {
        ...proposed.record,
        id: undefined,
        idempotency_key: "forged-handoff-capture",
      },
    }), /must use saveHandoff/);
    assert.equal(f.vault.get(proposed.record.id), null);
  } finally {
    f.cleanup();
  }
});

test("concurrent review approvals allow exactly one handoff lineage successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-approval-race-"));
  const vault = new ContextVault(root);
  const activeAssessment = {
    ...ACTIVE_HANDOFF,
    activation_ttl_seconds: 3_600,
    quota_limit: 10,
  };
  const heldAssessment = {
    disposition: "quarantined",
    reason: "review fixture",
    expires_at: null,
    activation_ttl_seconds: 3_600,
    quota_limit: 10,
  };
  const common = {
    tenant_id: "tenant-a",
    owner_id: "owner-a",
    agent_id: "agent-a",
    project_id: "api",
    task_id: "concurrent-approval",
    goal: "Choose one reviewed successor",
    branch: "main",
  };
  try {
    vault.saveHandoff({
      ...common,
      checkpoint_id: "checkpoint-1",
      current_state: "Initial state",
    }, { assessment: activeAssessment });
    const left = vault.saveHandoff({
      ...common,
      checkpoint_id: "checkpoint-2-left",
      previous_checkpoint_id: "checkpoint-1",
      current_state: "Left candidate",
      sensitivity: "sensitive",
    }, { assessment: heldAssessment });
    const right = vault.saveHandoff({
      ...common,
      checkpoint_id: "checkpoint-2-right",
      previous_checkpoint_id: "checkpoint-1",
      current_state: "Right candidate",
      sensitivity: "sensitive",
    }, { assessment: heldAssessment });
    vault.close();

    const startAt = Date.now() + 250;
    const outcomes = await Promise.all([
      runConcurrentApproval(root, left.record.id, startAt),
      runConcurrentApproval(root, right.record.id, startAt),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    const loser = outcomes.find((outcome) => !outcome.ok);
    assert.equal(loser.statusCode, 409);
    assert.match(loser.message, /approval lineage conflict/);

    const reopened = new ContextVault(root);
    const latest = reopened.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "concurrent-approval",
      branch: "main",
      allowed_sensitivities: ["sensitive"],
    });
    assert.ok([left.record.id, right.record.id].includes(latest.record.id));
    assert.equal(reopened.listMemories({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      allowed_projects: ["api"],
      allowed_sensitivities: ["sensitive"],
      project_id: "api",
      statuses: ["quarantined"],
    }).filter((record) => record.type === "handoff").length, 1);
    reopened.close();
  } finally {
    try { vault.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple processes serialize one authoritative audit hash chain", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-audit-writers-"));
  const first = new ContextVault(root);
  const second = new ContextVault(root);
  try {
    first.propose({ body: "Writer one event." });
    second.propose({ body: "Writer two event." });
    first.propose({ body: "Writer one second event." });
    const verification = second.verifyAuditLog();
    assert.equal(verification.valid, true);
    assert.equal(verification.events, 3);
    assert.equal(verification.storage, "sqlite-serialized");
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy JSONL audit events migrate once into the serialized audit table", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-audit-migration-"));
  try {
    const legacy = auditEvent({
      event_id: "legacy-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      actor: "legacy-user",
      operation: "propose",
      target_id: "memory-1",
      result: "created",
      previous_hash: null,
    });
    writeFileSync(join(root, "audit.jsonl"), `${JSON.stringify(legacy)}\n`);
    const vault = new ContextVault(root);
    const verification = vault.verifyAuditLog();
    assert.equal(verification.valid, true);
    assert.equal(verification.events, 1);
    assert.equal(verification.head, legacy.event_hash);
    assert.equal(verification.legacy.valid, true);
    assert.equal(vault.db.prepare("SELECT event_hash FROM audit_events").get().event_hash, legacy.event_hash);
    vault.close();
    const reopened = new ContextVault(root);
    assert.equal(reopened.verifyAuditLog().events, 1);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy audit migration preserves and reports a broken historical chain", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-audit-corruption-"));
  try {
    const first = auditEvent({
      event_id: "legacy-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      actor: "legacy-user",
      operation: "propose",
      target_id: "memory-1",
      result: "created",
      previous_hash: null,
    });
    const corrupted = auditEvent({
      event_id: "legacy-2",
      timestamp: "2026-01-01T00:00:01.000Z",
      actor: "legacy-user",
      operation: "commit",
      target_id: "memory-1",
      result: "active",
      previous_hash: "f".repeat(64),
    });
    const source = `${JSON.stringify(first)}\n${JSON.stringify(corrupted)}\n`;
    writeFileSync(join(root, "audit.jsonl"), source);
    const vault = new ContextVault(root);
    const verification = vault.verifyAuditLog();
    assert.equal(verification.valid, false);
    assert.equal(verification.broken_at, 2);
    assert.match(verification.legacy.reason, /legacy audit/);
    assert.equal(verification.legacy.source_sha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
    assert.equal(readFileSync(join(root, "audit.jsonl"), "utf8"), source);
    vault.close();

    const reopened = new ContextVault(root);
    assert.equal(reopened.verifyAuditLog().valid, false);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy audit migration reports a chain that conflicts with existing SQLite history", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-audit-mismatch-"));
  try {
    const initial = new ContextVault(root);
    initial.propose({ body: "Existing SQLite event", namespace_id: "personal/global" });
    initial.close();

    const legacy = auditEvent({
      event_id: "different-legacy-event",
      timestamp: "2026-01-01T00:00:00.000Z",
      actor: "legacy-user",
      operation: "propose",
      target_id: "memory-legacy",
      result: "created",
      previous_hash: null,
    });
    const source = `${JSON.stringify(legacy)}\n`;
    writeFileSync(join(root, "audit.jsonl"), source);

    const reopened = new ContextVault(root);
    const verification = reopened.verifyAuditLog();
    assert.equal(verification.valid, false);
    assert.match(verification.legacy.reason, /does not preserve the legacy hash chain/);
    assert.equal(readFileSync(join(root, "audit.jsonl"), "utf8"), source);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
