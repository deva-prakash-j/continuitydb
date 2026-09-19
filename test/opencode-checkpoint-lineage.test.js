import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createContinuityServer } from "../src/http-server.js";
import { renderOpenCodePlugin } from "../src/opencode-plugin-template.js";
import { ContextVault } from "../src/store.js";

test("generated HTTP checkpoint A then B then retry A preserves historical lineage and truthful status", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-delayed-retry-"));
  const vault = new ContextVault(join(root, "vault"));
  const service = createContinuityServer({
    vault, host: "127.0.0.1", port: 0,
    localIdentity: {
      tenant_id: "local", owner_id: "local-user", principal_id: "opencode", agent_id: "opencode",
      scopes: ["memory:read", "memory:capture"], allowed_projects: ["lineage-project"],
      allowed_sensitivities: ["private"],
    },
  });
  const priorFile = process.env.CONTINUITYDB_HANDOFF_FILE;
  try {
    const address = await service.listen();
    const modulePath = join(root, "plugin.mjs");
    writeFileSync(modulePath, renderOpenCodePlugin({
      projectId: "lineage-project", transport: "http",
      url: `http://127.0.0.1:${address.port}/mcp`, tokenEnv: "OPENCODE_LINEAGE_TEST_TOKEN",
    }));
    const module = await import(pathToFileURL(modulePath).href);
    const plugin = await module.ContinuityDBPlugin({ directory: root });
    const file = join(root, "handoff.json");
    process.env.CONTINUITYDB_HANDOFF_FILE = file;
    const checkpointA = {
      project_id: "lineage-project", task_id: "delayed-retry", checkpoint_id: "checkpoint-a",
      goal: "Preserve historical retry identity", current_state: "Original state", branch: "main",
    };
    const save = async (checkpoint) => {
      writeFileSync(file, JSON.stringify(checkpoint));
      return plugin.event({ event: { type: "session.idle" } });
    };
    const storedHandoff = (id) => JSON.parse(vault.get(id, { includeInactive: true }).metadata_json).handoff;
    const latest = () => vault.latestHandoff({
      project_id: checkpointA.project_id, task_id: checkpointA.task_id, branch: checkpointA.branch,
    });

    const first = await save(checkpointA);
    assert.equal(first.saved, true);
    assert.equal(first.duplicate, false);
    const originalHandoff = storedHandoff(first.memory_id);
    assert.equal(originalHandoff.previous_checkpoint_id, null);
    const second = await save({
      ...checkpointA, checkpoint_id: "checkpoint-b", current_state: "Successor state",
    });
    assert.equal(second.saved, true);
    assert.equal(second.duplicate, false);
    assert.equal(storedHandoff(second.memory_id).previous_checkpoint_id, checkpointA.checkpoint_id);
    const auditBeforeRetry = vault.verifyAuditLog().events;

    const retry = await save(checkpointA);
    assert.equal(retry.memory_id, first.memory_id);
    assert.equal(retry.checkpoint_id, checkpointA.checkpoint_id);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.saved, false);
    assert.equal(retry.accepted, true);
    assert.equal(retry.status, "superseded");
    assert.equal(retry.disposition, "superseded");
    assert.deepEqual(storedHandoff(first.memory_id), originalHandoff);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), checkpointA);
    assert.equal(latest().record.id, second.memory_id);
    assert.equal(latest().handoff.previous_checkpoint_id, checkpointA.checkpoint_id);

    await assert.rejects(save({ ...checkpointA, current_state: "Changed original state" }),
      /not saved: checkpoint_id was already used with different handoff data/);
    assert.equal(latest().record.id, second.memory_id);
    assert.deepEqual(storedHandoff(first.memory_id), originalHandoff);
    assert.equal(vault.verifyAuditLog().events, auditBeforeRetry);
    assert.equal(vault.verifyAuditLog().valid, true);
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM memory_records").get().count, 2);
  } finally {
    if (priorFile === undefined) delete process.env.CONTINUITYDB_HANDOFF_FILE;
    else process.env.CONTINUITYDB_HANDOFF_FILE = priorFile;
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});
