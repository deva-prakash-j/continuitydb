import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNodeServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";
import { registerProject } from "../src/project-registry.js";

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

function seedLocalMemory(root, projectId, body) {
  const home = join(root, "vault");
  registerProject(home, { id: projectId, root: join(root, "project"), source: "explicit" }, { apply: true });
  const vault = new ContextVault(home);
  try {
    const proposed = vault.propose({
      tenant_id: "local",
      owner_id: "local-user",
      namespace_id: `project/${projectId}`,
      project_id: projectId,
      body,
      sensitivity: "private",
    });
    vault.approve(proposed.record.id, { actor: "fixture" });
  } finally {
    vault.close();
  }
  return home;
}

test("session-start reads a registered local vault without HTTP or a task id", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-hook-test-"));
  try {
    const home = seedLocalMemory(root, "billing-api", "Use the v2 schema for billing rollout");
    const startup = JSON.parse(await runHook(["session-start", "--client", "claude"], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_TASK: "Continue billing rollout",
      CONTINUITYDB_TOKEN_BUDGET: "300",
      CONTINUITYDB_HTTP_URL: "",
      CONTINUITYDB_TASK_ID: "",
    }));
    const context = startup.hookSpecificOutput.additionalContext;
    assert.match(context, /Use the v2 schema/);
    assert.match(context, /Latest structured handoff\nNone found/);
    assert.doesNotMatch(context, /HTTP_URL.*required/);
    assert.match(context, /"requested_tokens": 300/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local lifecycle recall fails closed for an unregistered fixed project", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-hook-scope-test-"));
  try {
    const home = seedLocalMemory(root, "registered-project", "Registered memory marker");
    await assert.rejects(runHook(["session-start"], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "wrong-project",
      CONTINUITYDB_TASK: "Find marker",
      CONTINUITYDB_HTTP_URL: "",
      CONTINUITYDB_TASK_ID: "",
    }), /project wrong-project is not registered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle recall rejects an unbounded token budget before opening transport", async () => {
  await assert.rejects(runHook(["session-start", "--token-budget", "32001"], {
    CONTINUITYDB_HOME: "/unused",
    CONTINUITYDB_PROJECT_ID: "billing-api",
    CONTINUITYDB_TASK: "Continue rollout",
    CONTINUITYDB_HTTP_URL: "",
  }), /token_budget must be an integer between 64 and 32000/);
});

test("remote lifecycle requires a secure URL and an explicit token environment reference", async () => {
  await assert.rejects(runHook(["session-start"], {
    CONTINUITYDB_HTTP_URL: "http://memory.example/v1",
    CONTINUITYDB_HTTP_TOKEN_ENV: "HOOK_TOKEN",
    HOOK_TOKEN: "not-a-real-secret-value-for-test",
    CONTINUITYDB_PROJECT_ID: "billing-api",
    CONTINUITYDB_TASK: "Continue rollout",
  }), /must use HTTPS/);
  await assert.rejects(runHook(["session-start"], {
    CONTINUITYDB_HTTP_URL: "https://memory.example/v1",
    CONTINUITYDB_HTTP_TOKEN_ENV: "",
    CONTINUITYDB_PROJECT_ID: "billing-api",
    CONTINUITYDB_TASK: "Continue rollout",
  }), /HTTP_TOKEN_ENV.*required/);
});

test("remote lifecycle reads the token only through its named environment reference", async () => {
  const requests = [];
  const server = createNodeServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      project_id: "billing-api",
      task: "Continue rollout",
      budget: { requested_tokens: 1200, estimated_tokens: 40 },
      memories: [{ body: "Remote lifecycle marker" }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const output = JSON.parse(await runHook(["session-start", "--client", "cursor"], {
      CONTINUITYDB_HTTP_URL: `http://127.0.0.1:${address.port}`,
      CONTINUITYDB_HTTP_TOKEN_ENV: "CONTINUITYDB_TEST_REMOTE_TOKEN",
      CONTINUITYDB_TEST_REMOTE_TOKEN: "test-only-token-value-with-length",
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_TASK: "Continue rollout",
      CONTINUITYDB_TASK_ID: "",
    }));
    assert.match(output.additional_context, /Remote lifecycle marker/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/context-packs");
    assert.equal(requests[0].authorization, "Bearer test-only-token-value-with-length");
    assert.equal(requests[0].body.project_id, "billing-api");
    assert.equal(requests[0].body.token_budget, 1200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("checkpoint accepts only the fixed project's structured handoff file", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-checkpoint-shape-test-"));
  try {
    const home = seedLocalMemory(root, "billing-api", "Checkpoint fixture");
    const base = {
      project_id: "billing-api",
      task_id: "rollout",
      goal: "Ship billing",
      current_state: "Ready",
      checkpoint_id: "checkpoint-1",
    };
    const unsafe = join(root, "unsafe.json");
    writeFileSync(unsafe, JSON.stringify({ ...base, transcript: "raw transcript must not be mined" }));
    await assert.rejects(runHook(["checkpoint", "--file", unsafe], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_HTTP_URL: "",
    }), /unsupported field: transcript/);

    await assert.rejects(runHook(["checkpoint"], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_HTTP_URL: "",
    }), /checkpoint requires --file/);

    assert.equal(await runHook(["checkpoint", "--file", join(root, "missing.json")], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_HTTP_URL: "",
    }), "{}\n");

    const wrong = join(root, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ ...base, project_id: "other-project" }));
    await assert.rejects(runHook(["checkpoint", "--file", wrong], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_HTTP_URL: "",
    }), /does not match configured project/);

    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, JSON.stringify({ ...base, current_state: "x".repeat(129 * 1024) }));
    await assert.rejects(runHook(["checkpoint", "--file", oversized], {
      CONTINUITYDB_HOME: home,
      CONTINUITYDB_PROJECT_ID: "billing-api",
      CONTINUITYDB_HTTP_URL: "",
    }), /too large/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      CONTINUITYDB_HTTP_TOKEN_ENV: "CONTINUITYDB_TEST_HOOK_TOKEN",
      CONTINUITYDB_PROJECT_ID: "api",
      CONTINUITYDB_TASK_ID: "schema-v2",
      CONTINUITYDB_BRANCH: "main",
      CONTINUITYDB_TASK: "Continue SchemaV2 rollout shared context",
    };
    for (const handoff of [{
      project_id: "api",
      task_id: "schema-v2",
      goal: "Ship SchemaV2",
      current_state: "OBSOLETE_SAME_TASK_CHECKPOINT shared context",
      branch: "main",
      checkpoint_id: "old-checkpoint",
    }, {
      project_id: "api",
      task_id: "other-task",
      goal: "Unrelated work",
      current_state: "OTHER_TASK_CHECKPOINT shared context",
      branch: "main",
      checkpoint_id: "other-checkpoint",
    }]) {
      const seeded = await fetch(`http://127.0.0.1:${address.port}/v1/handoffs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(handoff),
      });
      assert.equal(seeded.status, 201);
    }
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
    const startup = JSON.parse(await runHook(["session-start"], env));
    assert.equal(startup.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(startup.hookSpecificOutput.additionalContext, /Latest structured handoff/);
    assert.match(startup.hookSpecificOutput.additionalContext, /Regenerate the client/);
    assert.doesNotMatch(startup.hookSpecificOutput.additionalContext, /OBSOLETE_SAME_TASK_CHECKPOINT/);
    assert.doesNotMatch(startup.hookSpecificOutput.additionalContext, /OTHER_TASK_CHECKPOINT/);
    const cursor = JSON.parse(await runHook(["session-start", "--client", "cursor"], env));
    assert.match(cursor.additional_context, /Schema published/);
    const linkedCheckpoint = join(root, "linked-handoff.json");
    symlinkSync(checkpoint, linkedCheckpoint);
    await assert.rejects(
      runHook(["checkpoint", "--file", linkedCheckpoint], env),
      /regular file, not a symlink/,
    );
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});
