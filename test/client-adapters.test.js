import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ContinuityDBPlugin } from "../examples/clients/opencode-continuitydb.js";
import { createContinuityServer } from "../src/http-server.js";
import { ContextVault } from "../src/store.js";

test("versioned client configuration examples pass contract validation", () => {
  const script = fileURLToPath(new URL("../scripts/validate-client-adapters.js", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.valid, true);
  assert.deepEqual(value.clients, ["codex", "claude", "opencode", "cursor", "copilot"]);
  assert.equal(value.generated_assets, 12);
  assert.equal(value.managed_policies, 4);
  assert.deepEqual(value.generated_examples, [
    "examples/claude-code-hooks.example.json",
    "examples/cursor-hooks.example.json",
    "examples/clients/claude-code.hooks.json",
    "examples/clients/codex.AGENTS.md",
  ]);
  assert.equal(value.shipped_examples, 12);
  assert.equal(value.semantically_validated_examples, 12);
  assert.equal(value.standalone_tree_validator, true);
});

test("client validator canonicalizes its own temporary root across a platform symlink alias", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-client-validator-alias-"));
  const physicalTmp = join(root, "physical-tmp");
  const aliasedTmp = join(root, "aliased-tmp");
  const script = fileURLToPath(new URL("../scripts/validate-client-adapters.js", import.meta.url));
  try {
    mkdirSync(physicalTmp);
    symlinkSync(physicalTmp, aliasedTmp, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: aliasedTmp, TMP: aliasedTmp, TEMP: aliasedTmp },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client validator normalizes generated paths structurally when its temporary root contains backslashes", {
  skip: process.platform === "win32" ? "backslash is a path separator on Windows" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-client-validator-backslash-\\"));
  const script = fileURLToPath(new URL("../scripts/validate-client-adapters.js", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client validator rejects drift in every shipped generated hook example", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-client-example-drift-"));
  const examples = join(root, "examples");
  const script = fileURLToPath(new URL("../scripts/validate-client-adapters.js", import.meta.url));
  try {
    cpSync(new URL("../examples", import.meta.url), examples, { recursive: true });
    const path = join(examples, "clients", "claude-code.hooks.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.hooks.SessionStart[0].hooks[0].command = "drifted-hook";
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    const result = spawnSync(process.execPath, [script, "--examples-root", examples], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "drifted shipped Claude hook example was ignored");
    assert.match(result.stderr, /claude-code\.hooks\.json|generated hook example/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client validator rejects a stale OpenCode plugin reference", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-example-drift-"));
  const examples = join(root, "examples");
  const script = fileURLToPath(new URL("../scripts/validate-client-adapters.js", import.meta.url));
  try {
    cpSync(new URL("../examples", import.meta.url), examples, { recursive: true });
    const path = join(examples, "clients", "opencode.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.plugin = ["./missing-stale-plugin.js"];
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    const result = spawnSync(process.execPath, [script, "--examples-root", examples], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "stale OpenCode plugin reference was accepted");
    assert.match(result.stderr, /opencode.*plugin/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client validator rejects a stale Codex stdio executable", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-codex-example-drift-"));
  const examples = join(root, "examples");
  const script = fileURLToPath(new URL("../scripts/validate-client-adapters.js", import.meta.url));
  try {
    cpSync(new URL("../examples", import.meta.url), examples, { recursive: true });
    const path = join(examples, "clients", "codex.stdio.config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace('command = "continuitydb"', 'command = "definitely-stale-command"'));
    const result = spawnSync(process.execPath, [script, "--examples-root", examples], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "stale Codex executable was accepted");
    assert.match(result.stderr, /codex.*command|command.*continuitydb/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
