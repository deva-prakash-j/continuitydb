import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContinuityServer } from "../src/http-server.js";
import { loadLifecycleContext, saveLifecycleCheckpoint } from "../src/lifecycle-context.js";
import { linkCheckpointToLatest } from "../src/lifecycle-lineage.js";
import { registerProject } from "../src/project-registry.js";
import { ContextVault } from "../src/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-lifecycle-context-"));
  const home = join(root, "vault");
  registerProject(home, { id: "api", root: join(root, "project"), source: "explicit" }, { apply: true });
  return { root, home };
}

test("local lifecycle uses its supplied capture policy for checkpoint TTL and quota", async () => {
  const { root, home } = fixture();
  try {
    const policy = join(root, "capture-policy.json");
    writeFileSync(policy, JSON.stringify({ working_ttl_seconds: 600, max_records_per_project_per_agent: 100 }), { mode: 0o600 });
    chmodSync(policy, 0o600);
    const options = { home, projectId: "api", env: { CONTINUITYDB_CAPTURE_POLICY_FILE: policy } };
    const checkpoint = { project_id: "api", task_id: "configured-policy", checkpoint_id: "policy-1", goal: "Configured lifetime", current_state: "Initial state" };
    const before = Date.now();
    const first = await saveLifecycleCheckpoint({ ...options, checkpoint });
    assert.equal(first.disposition, "active");
    assert.ok(Date.parse(first.record.expires_at) >= before + 600_000);
    assert.ok(Date.parse(first.record.expires_at) <= Date.now() + 600_000);
    assert.deepEqual(JSON.parse(first.record.metadata_json).governance, { quota_limit: 100, activation_ttl_seconds: 600 });

    const vault = new ContextVault(home);
    try {
      for (let index = 0; index < 99; index += 1) {
        vault.propose({
          tenant_id: "local", owner_id: "local-user", agent_id: "lifecycle-hook",
          namespace_id: "project/api", project_id: "api", body: `Synthetic quota fixture ${index}`,
        });
      }
    } finally { vault.close(); }
    assert.equal((await saveLifecycleCheckpoint({ ...options, checkpoint })).duplicate, true);
    await assert.rejects(saveLifecycleCheckpoint({
      ...options,
      checkpoint: { ...checkpoint, task_id: "second-task", checkpoint_id: "policy-2" },
    }), /capture quota exceeded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("automatic lineage leaves explicit predecessors untouched and ignores branch fallback", () => {
  const latest = { handoff: { branch: null, checkpoint_id: "global-1" } };
  const explicit = { branch: "main", checkpoint_id: "main-1", previous_checkpoint_id: "explicit-1" };
  assert.deepEqual(linkCheckpointToLatest(explicit, latest), explicit);
  assert.deepEqual(linkCheckpointToLatest({ branch: "main", checkpoint_id: "main-1" }, latest), {
    branch: "main", checkpoint_id: "main-1",
  });
});

for (const transport of ["local", "http"]) test(`${transport} lifecycle separates branchless recall from named-branch lineage`, async () => {
  const { root, home } = fixture();
  let service = null;
  try {
    const options = { home, projectId: "api", env: {} };
    if (transport === "http") {
      service = createContinuityServer({
        vault: new ContextVault(home), host: "127.0.0.1", port: 0,
        localIdentity: {
          tenant_id: "local", owner_id: "local-user", principal_id: "lifecycle-hook", agent_id: "lifecycle-hook",
          scopes: ["memory:read", "memory:capture"], allowed_projects: ["api"], allowed_sensitivities: ["private"],
        },
      });
      const address = await service.listen();
      options.remoteUrl = `http://127.0.0.1:${address.port}`;
      options.tokenEnv = "CONTINUITYDB_FIXTURE_TOKEN";
    }
    const checkpoint = { project_id: "api", task_id: "branch-task", goal: "Keep branch lineage", current_state: "Synthetic state" };
    const global = await saveLifecycleCheckpoint({ ...options, checkpoint: { ...checkpoint, checkpoint_id: "global-1" } });
    assert.equal(global.disposition, "active");
    const recalled = await loadLifecycleContext({ ...options, taskId: "branch-task", branch: "main", task: "Continue fixture" });
    assert.equal(recalled.handoff.handoff.checkpoint_id, "global-1");
    const first = await saveLifecycleCheckpoint({ ...options, checkpoint: { ...checkpoint, branch: "main", checkpoint_id: "main-1" } });
    assert.equal(first.disposition, "active");
    assert.equal(first.handoff.previous_checkpoint_id, null);
    const successor = { ...checkpoint, branch: "main", checkpoint_id: "main-2" };
    const second = await saveLifecycleCheckpoint({ ...options, checkpoint: successor });
    assert.equal(second.disposition, "active");
    assert.equal(second.handoff.previous_checkpoint_id, "main-1");
    const retry = await saveLifecycleCheckpoint({ ...options, checkpoint: successor });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.record.id, second.record.id);
    const globalRecall = await loadLifecycleContext({ ...options, taskId: "branch-task", task: "Continue fixture" });
    assert.equal(globalRecall.handoff.handoff.checkpoint_id, "global-1");
  } finally {
    await service?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
