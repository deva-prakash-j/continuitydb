import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";

function runHook(args, env) {
  const hook = new URL("../src/lifecycle-hook.js", import.meta.url).pathname;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `hook exited ${code}`)));
  });
}

test("lifecycle hook injects startup context and saves explicit structured checkpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-hook-test-"));
  const vault = new ContextVault(join(root, "vault"));
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    localIdentity: {
      tenant_id: "tenant-a",
      principal_id: "hook-agent",
      owner_id: "owner-a",
      agent_id: "claude",
      scopes: ["memory:read", "memory:capture"],
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
    },
  });
  try {
    const address = await service.listen();
    const env = {
      CONTINUITYDB_HTTP_URL: `http://127.0.0.1:${address.port}`,
      CONTINUITYDB_PROJECT_ID: "api",
      CONTINUITYDB_TASK_ID: "schema-v2",
      CONTINUITYDB_BRANCH: "main",
      CONTINUITYDB_TASK: "Continue SchemaV2 rollout",
    };
    const checkpoint = join(root, "handoff.json");
    writeFileSync(checkpoint, JSON.stringify({
      project_id: "api",
      task_id: "schema-v2",
      goal: "Ship SchemaV2",
      current_state: "Schema published",
      next_actions: ["Regenerate the client"],
      branch: "main",
      checkpoint_id: "hook-checkpoint-1",
    }));
    const saved = JSON.parse(await runHook(["checkpoint", "--file", checkpoint, "--verbose"], env));
    assert.equal(saved.saved, true);
    const startup = await runHook(["session-start"], env);
    assert.match(startup, /Latest structured handoff/);
    assert.match(startup, /Regenerate the client/);
    const cursor = JSON.parse(await runHook(["session-start", "--client", "cursor"], env));
    assert.match(cursor.additional_context, /Schema published/);
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});
