import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderOpenCodePlugin } from "../src/opencode-plugin-template.js";
import { saveLifecycleCheckpoint } from "../src/lifecycle-context.js";
import { createContinuityServer } from "../src/http-server.js";
import { registerProject } from "../src/project-registry.js";
import { ContextVault } from "../src/store.js";

const SOURCE_HOOK = new URL("../src/lifecycle-hook.js", import.meta.url).pathname;

async function importGenerated(root, options) {
  const path = join(root, "continuitydb.js");
  writeFileSync(path, renderOpenCodePlugin(options));
  return import(`${pathToFileURL(path).href}?fixture=${crypto.randomUUID()}`);
}

function installHookWrapper(root) {
  return installHookExecutable(root).bin;
}

function installHookExecutable(root, {
  directory = "bin",
  name = "continuitydb",
} = {}) {
  const bin = join(root, directory);
  mkdirSync(bin);
  const path = join(bin, name);
  const module = join(root, `hook-wrapper-${crypto.randomUUID()}.mjs`);
  writeFileSync(module, `import { runLifecycleHook } from ${JSON.stringify(pathToFileURL(SOURCE_HOOK).href)};\nif (process.argv[2] === "hook") process.argv.splice(2, 1);\nprocess.exitCode = await runLifecycleHook();\n`);
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(module)} "$@"\n`);
  chmodSync(path, 0o700);
  return { bin, path };
}

function seedLocal(root, projectId) {
  const home = join(root, "vault");
  const project = join(root, "project");
  mkdirSync(project);
  registerProject(home, { id: projectId, root: project, source: "explicit" }, { apply: true });
  const vault = new ContextVault(home);
  const proposed = vault.propose({
    tenant_id: "tenant-a", owner_id: "owner-a", namespace_id: `project/${projectId}`,
    project_id: projectId, body: "LOCAL_OPENCODE_RECALL_MARKER", sensitivity: "private",
  });
  vault.approve(proposed.record.id, { actor: "fixture" });
  vault.close();
  return { home, project };
}

function withEnvironment(changes, callback) {
  const original = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  return Promise.resolve().then(callback).finally(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("generated local OpenCode plugin recalls registered project context without an HTTP daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-local-"));
  try {
    const { home, project } = seedLocal(root, "inventory.v2");
    const bin = installHookWrapper(root);
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "stdio", home,
      tenantId: "tenant-a", ownerId: "owner-a", sensitivities: ["private"],
    });
    await withEnvironment({
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
      CONTINUITYDB_TASK: "Find LOCAL_OPENCODE_RECALL_MARKER",
      CONTINUITYDB_TASK_ID: "",
      CONTINUITYDB_HTTP_URL: "",
    }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: project });
      const output = { context: [] };
      await plugin["experimental.session.compacting"]({}, output);
      assert.equal(output.context.length, 1);
      assert.match(output.context[0], /LOCAL_OPENCODE_RECALL_MARKER/);
      assert.match(output.context[0], /inventory\.v2/);
      assert.match(output.context[0], /untrusted evidence/i);
      assert.doesNotMatch(output.context[0], /HTTP daemon/i);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional OpenCode task id skips latest handoff but still recalls bounded context", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-taskless-"));
  try {
    const { home, project } = seedLocal(root, "inventory.v2");
    const bin = installHookWrapper(root);
    await saveLifecycleCheckpoint({
      home, projectId: "inventory.v2", tenantId: "tenant-a", ownerId: "owner-a", agentId: "fixture",
      allowedSensitivities: ["private"], checkpoint: {
      project_id: "inventory.v2", task_id: "old-task", goal: "resume", current_state: "LATEST_HANDOFF_MARKER",
      checkpoint_id: "checkpoint-1", sensitivity: "private",
      },
    });
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "stdio", home,
      tenantId: "tenant-a", ownerId: "owner-a", sensitivities: ["private"],
    });
    await withEnvironment({
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
      CONTINUITYDB_TASK: "Find LOCAL_OPENCODE_RECALL_MARKER",
      CONTINUITYDB_TASK_ID: "",
    }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: project });
      const output = { context: [] };
      await plugin["experimental.session.compacting"]({}, output);
      assert.match(output.context[0], /LOCAL_OPENCODE_RECALL_MARKER/);
      assert.doesNotMatch(output.context[0], /LATEST_HANDOFF_MARKER/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated local plugin uses the exact configured executable without PATH lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-executable-"));
  try {
    const { home, project } = seedLocal(root, "inventory.v2");
    const executable = installHookExecutable(root, {
      directory: "custom bin 'quoted' \\path",
      name: "continuity db 'hook' \\binary",
    }).path;
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "stdio", home, executable,
      tenantId: "tenant-a", ownerId: "owner-a", sensitivities: ["private"],
    });
    const handoff = join(project, ".continuitydb-handoff.json");
    writeFileSync(handoff, JSON.stringify({
      project_id: "inventory.v2", task_id: "custom-binary-task", goal: "Use fixed executable",
      current_state: "CUSTOM_BINARY_CHECKPOINT", checkpoint_id: "custom-binary-checkpoint-1",
    }));
    await withEnvironment({
      PATH: "/usr/bin:/bin",
      CONTINUITYDB_TASK: "Find LOCAL_OPENCODE_RECALL_MARKER",
      CONTINUITYDB_TASK_ID: "",
    }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: project });
      const output = { context: [] };
      await plugin["experimental.session.compacting"]({}, output);
      assert.match(output.context[0], /LOCAL_OPENCODE_RECALL_MARKER/);
      const result = await plugin.event({ event: { type: "session.idle" } });
      assert.equal(result.saved, true);
      const vault = new ContextVault(home);
      assert.equal(vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "custom-binary-task",
        allowed_sensitivities: ["private"],
      }).handoff.current_state, "CUSTOM_BINARY_CHECKPOINT");
      vault.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderer validates remote transport and embeds only the token environment reference", () => {
  assert.throws(() => renderOpenCodePlugin({
    projectId: "inventory.v2", transport: "http", url: "http://memory.example/mcp", tokenEnv: "VAULT_TOKEN",
  }), /HTTPS/);
  assert.throws(() => renderOpenCodePlugin({
    projectId: "inventory.v2", transport: "http", url: "https://user:secret@memory.example/mcp", tokenEnv: "VAULT_TOKEN",
  }), /credentials/);
  assert.throws(() => renderOpenCodePlugin({
    projectId: "inventory.v2", transport: "http", url: "https://memory.example/mcp", tokenEnv: "PATH",
  }), /token environment/i);
  process.env.VAULT_TOKEN = "SECRET_VALUE_MUST_NOT_BE_RENDERED";
  try {
    const source = renderOpenCodePlugin({
      projectId: "inventory.v2", transport: "http", url: "https://memory.example/mcp", tokenEnv: "VAULT_TOKEN",
    });
    assert.match(source, /VAULT_TOKEN/);
    assert.doesNotMatch(source, /SECRET_VALUE_MUST_NOT_BE_RENDERED/);
    assert.doesNotMatch(source, /prompt|transcript|tool.?log/i);
  } finally {
    delete process.env.VAULT_TOKEN;
  }
});

test("generated remote plugin uses loopback HTTP with an environment token reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-remote-"));
  const vault = new ContextVault(join(root, "vault"));
  const service = createContinuityServer({
    vault, host: "127.0.0.1", port: 0,
    localIdentity: {
      tenant_id: "tenant-a", principal_id: "opencode-agent", owner_id: "owner-a", agent_id: "opencode",
      scopes: ["memory:read", "memory:capture"], allowed_projects: ["inventory.v2"], allowed_sensitivities: ["private", "restricted"],
    },
  });
  try {
    const proposed = vault.propose({
      tenant_id: "tenant-a", owner_id: "owner-a", namespace_id: "project/inventory.v2",
      project_id: "inventory.v2", body: "REMOTE_OPENCODE_RECALL_MARKER", sensitivity: "private",
    });
    vault.approve(proposed.record.id, { actor: "fixture" });
    const address = await service.listen();
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "http",
      url: `http://127.0.0.1:${address.port}/mcp`, tokenEnv: "OPENCODE_TEST_TOKEN",
    });
    const handoff = join(root, "handoff.json");
    writeFileSync(handoff, JSON.stringify({
      project_id: "inventory.v2", task_id: "remote-task", goal: "Continue remotely",
      current_state: "REMOTE_STRUCTURED_HANDOFF", checkpoint_id: "remote-checkpoint-1", branch: "main",
    }));
    await withEnvironment({
      OPENCODE_TEST_TOKEN: "test-token-value",
      CONTINUITYDB_TASK: "Find REMOTE_OPENCODE_RECALL_MARKER",
      CONTINUITYDB_TASK_ID: "",
      CONTINUITYDB_HANDOFF_FILE: handoff,
    }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: root });
      const output = { context: [] };
      await plugin["experimental.session.compacting"]({}, output);
      assert.match(output.context[0], /REMOTE_OPENCODE_RECALL_MARKER/);
      const first = await plugin.event({ event: { type: "session.idle" } });
      assert.equal(first.saved, true);
      assert.equal(first.duplicate, false);
      assert.equal(vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "remote-task",
        branch: "main",
        allowed_sensitivities: ["private"],
      }).handoff.current_state, "REMOTE_STRUCTURED_HANDOFF");

      const otherBranch = await fetch(`http://127.0.0.1:${address.port}/v1/handoffs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "inventory.v2", task_id: "remote-task", goal: "Other branch",
          current_state: "OTHER_BRANCH_HANDOFF", checkpoint_id: "other-branch-checkpoint", branch: "feature",
        }),
      });
      assert.equal(otherBranch.status, 201);

      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "remote-task", goal: "Continue remotely",
        current_state: "REMOTE_SUCCESSOR_HANDOFF", checkpoint_id: "remote-checkpoint-2", branch: "main",
      }));
      const successor = await plugin.event({ event: { type: "session.idle" } });
      const retry = await plugin.event({ event: { type: "session.idle" } });
      assert.equal(successor.saved, true);
      assert.equal(successor.duplicate, false);
      assert.equal(retry.saved, true);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.memory_id, successor.memory_id);
      const latest = vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "remote-task",
        branch: "main",
        allowed_sensitivities: ["private"],
      });
      assert.equal(latest.handoff.previous_checkpoint_id, "remote-checkpoint-1");
      assert.equal(latest.handoff.current_state, "REMOTE_SUCCESSOR_HANDOFF");

      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "remote-task", goal: "Continue remotely",
        current_state: "CHANGED_REUSE_MUST_FAIL", checkpoint_id: "remote-checkpoint-2", branch: "main",
      }));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /not saved/i);
      assert.equal(vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "remote-task",
        branch: "main",
        allowed_sensitivities: ["private"],
      }).handoff.current_state, "REMOTE_SUCCESSOR_HANDOFF");

      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "restricted-task", goal: "Held checkpoint",
        current_state: "RESTRICTED_HANDOFF", checkpoint_id: "restricted-checkpoint-1", sensitivity: "restricted",
      }));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /not saved.*quarantined/i);

      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "remote-task", goal: "Reject extra data",
        current_state: "not saved", checkpoint_id: "remote-checkpoint-2", messages: ["forbidden"],
      }));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /unsupported field: messages/);
    });
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated remote plugin reports denied handoff capture as not saved", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-denied-"));
  const vault = new ContextVault(join(root, "vault"));
  const service = createContinuityServer({
    vault, host: "127.0.0.1", port: 0,
    localIdentity: {
      tenant_id: "tenant-a", principal_id: "read-only-agent", owner_id: "owner-a", agent_id: "opencode",
      scopes: ["memory:read"], allowed_projects: ["inventory.v2"], allowed_sensitivities: ["private"],
    },
  });
  try {
    const address = await service.listen();
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "http",
      url: `http://127.0.0.1:${address.port}/mcp`, tokenEnv: "OPENCODE_DENIED_TEST_TOKEN",
    });
    const handoff = join(root, "handoff.json");
    writeFileSync(handoff, JSON.stringify({
      project_id: "inventory.v2", task_id: "denied-task", goal: "Must not bypass read-only",
      current_state: "DENIED_HANDOFF", checkpoint_id: "denied-checkpoint-1",
    }));
    await withEnvironment({ CONTINUITYDB_HANDOFF_FILE: handoff }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: root });
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /not saved.*scope.*memory:capture/i);
    });
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle save reads only the explicit structured handoff and fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-idle-"));
  try {
    const { home, project } = seedLocal(root, "inventory.v2");
    const bin = installHookWrapper(root);
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "stdio", home,
      tenantId: "tenant-a", ownerId: "owner-a", sensitivities: ["private"],
    });
    await withEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH || ""}`, CONTINUITYDB_HANDOFF_FILE: "" }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: project });
      await plugin.event({ event: { type: "session.idle", prompt: "never capture this prompt" } });

      const handoff = join(project, ".continuitydb-handoff.json");
      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "task-1", goal: "Resume safely",
        current_state: "EXACT_STRUCTURED_HANDOFF", checkpoint_id: "opencode-checkpoint-1",
      }));
      await plugin.event({ event: { type: "session.idle", transcript: "never capture this transcript" } });
      const vault = new ContextVault(home);
      assert.equal(vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "task-1",
        allowed_sensitivities: ["private"],
      }).handoff.current_state, "EXACT_STRUCTURED_HANDOFF");
      vault.close();

      writeFileSync(handoff, JSON.stringify({
        project_id: "other-project", task_id: "task-2", goal: "Wrong scope",
        current_state: "must fail", checkpoint_id: "opencode-checkpoint-2",
      }));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /does not match configured project/);

      writeFileSync(handoff, "x".repeat(129 * 1024));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /too large/);

      rmSync(handoff);
      const target = join(root, "target.json");
      writeFileSync(target, "{}");
      symlinkSync(target, handoff);
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /regular file, not a symlink/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated local plugin rejects quarantined checkpoints and preserves latest handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-local-quarantine-"));
  try {
    const { home, project } = seedLocal(root, "inventory.v2");
    const bin = installHookWrapper(root);
    const module = await importGenerated(root, {
      projectId: "inventory.v2", transport: "stdio", home,
      tenantId: "tenant-a", ownerId: "owner-a", sensitivities: ["private", "restricted"],
    });
    const handoff = join(project, ".continuitydb-handoff.json");
    await withEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH || ""}` }, async () => {
      const plugin = await module.ContinuityDBPlugin({ directory: project });
      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "local-quarantine-task", goal: "Resume safely",
        current_state: "LOCAL_ACTIVE_BASELINE", checkpoint_id: "local-checkpoint-1",
      }));
      assert.equal((await plugin.event({ event: { type: "session.idle" } })).saved, true);

      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "local-quarantine-task", goal: "Resume safely",
        current_state: "LOCAL_STALE_SUCCESSOR", checkpoint_id: "local-checkpoint-2",
        previous_checkpoint_id: "not-the-latest",
      }));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /not saved.*quarantined/i);

      writeFileSync(handoff, JSON.stringify({
        project_id: "inventory.v2", task_id: "local-restricted-task", goal: "Held work",
        current_state: "LOCAL_RESTRICTED_CHECKPOINT", checkpoint_id: "local-restricted-1",
        sensitivity: "restricted",
      }));
      await assert.rejects(plugin.event({ event: { type: "session.idle" } }), /not saved.*quarantined/i);

      const vault = new ContextVault(home);
      assert.equal(vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "local-quarantine-task",
        allowed_sensitivities: ["private", "restricted"],
      }).handoff.current_state, "LOCAL_ACTIVE_BASELINE");
      assert.equal(vault.latestHandoff({
        tenant_id: "tenant-a", owner_id: "owner-a", project_id: "inventory.v2", task_id: "local-restricted-task",
        allowed_sensitivities: ["private", "restricted"],
      }), null);
      vault.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
