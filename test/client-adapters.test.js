import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContinuityDBPlugin } from "../examples/clients/opencode-continuitydb.js";
import { createContinuityServer } from "../src/http-server.js";
import { ContextVault } from "../src/store.js";

test("versioned client configuration examples pass contract validation", () => {
  const script = new URL("../scripts/validate-client-adapters.js", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.valid, true);
  assert.deepEqual(value.clients, ["codex", "copilot", "claude-code", "opencode"]);
});

test("OpenCode plugin injects bounded continuity context and saves explicit idle checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-plugin-test-"));
  const vault = new ContextVault(join(root, "vault"));
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    localIdentity: {
      tenant_id: "tenant-a",
      principal_id: "opencode-agent",
      owner_id: "owner-a",
      agent_id: "opencode",
      scopes: ["memory:read", "memory:capture"],
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
    },
  });
  const original = Object.fromEntries([
    "CONTINUITYDB_HTTP_URL", "CONTINUITYDB_PROJECT_ID", "CONTINUITYDB_TASK_ID",
    "CONTINUITYDB_BRANCH", "CONTINUITYDB_TASK", "CONTINUITYDB_HANDOFF_FILE",
    "CONTINUITYDB_HTTP_TOKEN_ENV", "CONTINUITYDB_OPENCODE_TEST_TOKEN",
  ].map((key) => [key, process.env[key]]));
  try {
    const seeded = vault.propose({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      namespace_id: "project/api",
      project_id: "api",
      body: "OpenCodePluginMarker is cited continuity context.",
      sensitivity: "private",
    });
    vault.approve(seeded.record.id, { actor: "fixture" });
    const address = await service.listen();
    const handoffPath = join(root, "handoff.json");
    writeFileSync(handoffPath, JSON.stringify({
      project_id: "api",
      task_id: "interop-task",
      goal: "Continue across OpenCode sessions",
      current_state: "Adapter contract tested",
      checkpoint_id: "opencode-checkpoint-1",
      branch: "main",
    }));
    Object.assign(process.env, {
      CONTINUITYDB_HTTP_URL: `http://127.0.0.1:${address.port}`,
      CONTINUITYDB_PROJECT_ID: "api",
      CONTINUITYDB_TASK_ID: "interop-task",
      CONTINUITYDB_BRANCH: "main",
      CONTINUITYDB_TASK: "Find OpenCodePluginMarker",
      CONTINUITYDB_HANDOFF_FILE: handoffPath,
      CONTINUITYDB_HTTP_TOKEN_ENV: "CONTINUITYDB_OPENCODE_TEST_TOKEN",
      CONTINUITYDB_OPENCODE_TEST_TOKEN: "test-only-token",
    });
    const plugin = await ContinuityDBPlugin({ directory: root });
    const output = { context: [] };
    await plugin["experimental.session.compacting"]({}, output);
    assert.equal(output.context.length, 1);
    assert.match(output.context[0], /OpenCodePluginMarker/);
    await plugin.event({ event: { type: "session.idle" } });
    const latest = vault.latestHandoff({
      tenant_id: "tenant-a",
      owner_id: "owner-a",
      project_id: "api",
      task_id: "interop-task",
      branch: "main",
      allowed_sensitivities: ["private"],
    });
    assert.equal(latest.handoff.current_state, "Adapter contract tested");
    const linkedHandoff = join(root, "linked-handoff.json");
    symlinkSync(handoffPath, linkedHandoff);
    process.env.CONTINUITYDB_HANDOFF_FILE = linkedHandoff;
    await assert.rejects(
      plugin.event({ event: { type: "session.idle" } }),
      /regular file, not a symlink/,
    );
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});
