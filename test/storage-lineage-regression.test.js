import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContinuityApiClient } from "../src/http-client.js";
import { createContinuityServer } from "../src/http-server.js";
import { saveLifecycleCheckpoint } from "../src/lifecycle-context.js";
import { checkpointSaveOutcome } from "../src/lifecycle-lineage.js";
import { registerProject } from "../src/project-registry.js";
import { createContinuityMcpServer } from "../src/mcp-server.js";
import { normalizeIdentity } from "../src/security.js";
import { ContextVault } from "../src/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-storage-lineage-"));
  const home = join(root, "vault");
  registerProject(home, { id: "api", root: join(root, "project"), source: "explicit" }, { apply: true });
  return { root, home, vault: new ContextVault(home) };
}

const assessment = () => ({ disposition: "active", reason: "synthetic policy", expires_at: new Date(Date.now() + 3600_000).toISOString() });
const canonical = (vault, id) => JSON.parse(readFileSync(vault.recordPath(id), "utf8").split("\n")[1]);
const pending = (vault) => Number(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count);

test("bulk approval activates eligible existing proposals and repeated approval has no additional writes", () => {
  const f = fixture();
  try {
    const inputs = [
      { body: "Synthetic keyed proposal", idempotency_key: "proposal-key" },
      { body: "Synthetic content-matched proposal" },
    ];
    const proposed = f.vault.ingestBatch(inputs);
    assert.ok(proposed.every((record) => record.status === "proposed"));
    const active = f.vault.ingestBatch(inputs, { commit: true });
    assert.deepEqual(active.map((record) => record.id), proposed.map((record) => record.id));
    assert.ok(active.every((record) => record.status === "active"));
    assert.equal(f.vault.search({ query: "Synthetic" }).length, 2);
    for (const record of active) assert.equal(canonical(f.vault, record.id).status, "active");
    const auditBefore = f.vault.verifyAuditLog().events;
    assert.deepEqual(f.vault.ingestBatch(inputs, { commit: true }).map((record) => ({ ...record })), active);
    assert.equal(f.vault.verifyAuditLog().events, auditBefore);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("bulk approval preserves quarantined, tombstoned and superseded retry states", () => {
  const f = fixture();
  try {
    const inputs = ["quarantined", "tombstoned", "superseded"].map((status) => ({ body: `Synthetic ${status} memory`, idempotency_key: status }));
    const held = f.vault.capture({ disposition: "quarantined", reason: "synthetic review", record: inputs[0] }).record;
    const removed = f.vault.ingestBatch([inputs[1]], { commit: true })[0];
    f.vault.forget(removed.id);
    const old = f.vault.ingestBatch([inputs[2]], { commit: true })[0];
    f.vault.correct(old.id, { body: "Synthetic corrected memory" }, "Synthetic correction");
    const auditBefore = f.vault.verifyAuditLog().events;
    const results = f.vault.ingestBatch(inputs, { commit: true });
    assert.deepEqual(results.map((record) => record.id), [held.id, removed.id, old.id]);
    assert.deepEqual(results.map((record) => record.status), ["quarantined", "tombstoned", "superseded"]);
    assert.equal(f.vault.verifyAuditLog().events, auditBefore);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("bulk proposal plus activation commits before an EIO and reopen same-key retry stays active", () => {
  const f = fixture();
  let recovered;
  let closed = false;
  try {
    const input = { body: "Synthetic atomic batch memory", idempotency_key: "batch-eio" };
    f.vault.writeCanonicalFile = () => { throw Object.assign(new Error("synthetic I/O failure"), { code: "EIO" }); };
    assert.throws(() => f.vault.ingestBatch([input], { commit: true }), (error) => {
      assert.equal(error.code, "CANONICAL_PROJECTION_PENDING");
      assert.equal(error.committed, true);
      assert.equal(error.recovery_pending, true);
      assert.equal(error.cause.code, "EIO");
      return true;
    });
    const persisted = f.vault.db.prepare("SELECT * FROM memory_records").get();
    assert.equal(persisted.status, "active");
    assert.equal(pending(f.vault), 1);
    f.vault.close(); closed = true;
    recovered = new ContextVault(f.home);
    const retry = recovered.ingestBatch([input], { commit: true })[0];
    assert.equal(retry.id, persisted.id);
    assert.equal(retry.status, "active");
    assert.equal(canonical(recovered, retry.id).status, "active");
    assert.equal(pending(recovered), 0);
    assert.equal(recovered.search({ query: "atomic batch" }).length, 1);
    assert.equal(recovered.verifyAuditLog().valid, true);
  } finally { if (!closed) f.vault.close(); recovered?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("bulk activation failure rolls back that input's proposal without publishing it", () => {
  const f = fixture();
  try {
    f.vault.commit = () => { throw new Error("synthetic activation failure"); };
    assert.throws(() => f.vault.ingestBatch([{ body: "Synthetic rollback memory" }], { commit: true }), /synthetic activation failure/);
    assert.equal(f.vault.exportJsonl(), "");
    assert.equal(pending(f.vault), 0);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("opt-in store lineage resolves historical retry before linking a new successor", () => {
  const f = fixture();
  try {
    const common = { project_id: "api", task_id: "atomic-lineage", agent_id: "fixture", branch: "main", goal: "Synthetic goal", current_state: "Synthetic state", auto_link_previous: true };
    const first = f.vault.saveHandoff({ ...common, checkpoint_id: "a" }, { assessment: assessment() });
    const second = f.vault.saveHandoff({ ...common, checkpoint_id: "b" }, { assessment: assessment() });
    assert.equal(second.disposition, "active");
    assert.equal(second.handoff.previous_checkpoint_id, "a");
    const third = f.vault.saveHandoff({ ...common, checkpoint_id: "c" }, { assessment: assessment() });
    const auditBefore = f.vault.verifyAuditLog().events;
    for (const [checkpointId, original] of [["a", first], ["b", second]]) {
      const retry = f.vault.saveHandoff({ ...common, checkpoint_id: checkpointId }, { assessment: assessment() });
      assert.equal(retry.duplicate, true);
      assert.equal(retry.record.id, original.record.id);
      assert.equal(retry.disposition, "superseded");
      assert.deepEqual(retry.handoff, original.handoff);
      assert.deepEqual(checkpointSaveOutcome(retry), {
        saved: false, accepted: true, duplicate: true, disposition: "superseded", status: "superseded",
        reason: retry.reason, memory_id: original.record.id, checkpoint_id: checkpointId,
      });
    }
    for (const change of [{ current_state: "Changed state" }, { previous_checkpoint_id: "c" }, { checkpoint_id: "b", previous_checkpoint_id: null }]) {
      assert.throws(() => f.vault.saveHandoff({ ...common, checkpoint_id: "a", ...change }, { assessment: assessment() }), /already used with different handoff data/);
    }
    assert.equal(f.vault.verifyAuditLog().events, auditBefore);
    assert.equal(f.vault.latestHandoff({ project_id: "api", task_id: common.task_id, branch: "main" }).record.id, third.record.id);
    const explicitNull = f.vault.saveHandoff({ ...common, checkpoint_id: "d", previous_checkpoint_id: null }, { assessment: assessment() });
    assert.equal(explicitNull.disposition, "quarantined");
    assert.equal(checkpointSaveOutcome(explicitNull).accepted, false);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const transport of ["local", "http"]) test(`${transport} lifecycle A then B then unchanged retry A returns truthful historical status`, async () => {
  const f = fixture();
  let service;
  try {
    const options = { home: f.home, projectId: "api", env: {} };
    if (transport === "http") {
      service = createContinuityServer({
        vault: f.vault, host: "127.0.0.1", port: 0,
        localIdentity: { tenant_id: "local", owner_id: "local-user", principal_id: "lifecycle-hook", agent_id: "lifecycle-hook", scopes: ["memory:read", "memory:capture"], allowed_projects: ["api"], allowed_sensitivities: ["private"] },
      });
      const address = await service.listen();
      options.remoteUrl = `http://127.0.0.1:${address.port}`;
      options.tokenEnv = "CONTINUITYDB_FIXTURE_TOKEN";
    }
    const checkpoint = { project_id: "api", task_id: "delayed-retry", checkpoint_id: "a", goal: "Synthetic task", current_state: "Original state", branch: "main" };
    const first = await saveLifecycleCheckpoint({ ...options, checkpoint });
    const second = await saveLifecycleCheckpoint({ ...options, checkpoint: { ...checkpoint, checkpoint_id: "b", current_state: "Successor state" } });
    assert.equal(second.handoff.previous_checkpoint_id, "a");
    const retry = await saveLifecycleCheckpoint({ ...options, checkpoint });
    assert.equal(retry.record.id, first.record.id);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.disposition, "superseded");
    assert.equal(retry.handoff.previous_checkpoint_id, null);
    assert.equal(checkpointSaveOutcome(retry).accepted, true);
    for (const changed of [{ current_state: "Changed retry" }, { previous_checkpoint_id: "b" }]) {
      await assert.rejects(saveLifecycleCheckpoint({ ...options, checkpoint: { ...checkpoint, ...changed } }), /already used with different handoff data/);
    }
    assert.equal(f.vault.latestHandoff({ project_id: "api", task_id: checkpoint.task_id, branch: "main" }).record.id, second.record.id);
  } finally { if (service) await service.close(); else f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const proxy of [false, true]) test(`MCP ${proxy ? "HTTP proxy" : "local"} preserves opt-in delayed retry identity`, async () => {
  const f = fixture();
  const identity = normalizeIdentity({ tenant_id: "local", owner_id: "local-user", principal_id: "fixture", agent_id: "fixture", scopes: ["memory:capture"], allowed_projects: ["api"], allowed_sensitivities: ["private"] });
  const client = new Client({ name: "lineage-fixture", version: "1" });
  let service;
  let runtime;
  try {
    let apiClient = null;
    if (proxy) {
      service = createContinuityServer({ vault: f.vault, host: "127.0.0.1", port: 0, localIdentity: identity });
      const address = await service.listen();
      apiClient = new ContinuityApiClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    }
    runtime = createContinuityMcpServer({ apiClient, vault: f.vault, identity, env: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const checkpoint = { project_id: "api", task_id: "mcp-lineage", checkpoint_id: "a", goal: "Synthetic task", current_state: "Synthetic state", auto_link_previous: true };
    const save = (value) => client.callTool({ name: "handoff_checkpoint", arguments: value });
    const first = await save(checkpoint);
    const second = await save({ ...checkpoint, checkpoint_id: "b" });
    assert.equal(first.structuredContent.disposition, "active");
    assert.equal(second.structuredContent.disposition, "active");
    assert.equal(second.structuredContent.handoff.previous_checkpoint_id, "a");
    const retry = await save(checkpoint);
    assert.equal(retry.isError, undefined);
    assert.equal(retry.structuredContent.duplicate, true);
    assert.equal(retry.structuredContent.disposition, "superseded");
    assert.equal(retry.structuredContent.record.id, first.structuredContent.record.id);
    const wrong = await save({ ...checkpoint, previous_checkpoint_id: "b" });
    assert.equal(wrong.isError, true);
    const explicit = await save({ ...checkpoint, checkpoint_id: "c", previous_checkpoint_id: null });
    assert.equal(explicit.isError, undefined);
    assert.equal(explicit.structuredContent.disposition, "quarantined");
  } finally {
    await client.close();
    await runtime?.server.close();
    if (service) await service.close(); else f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
