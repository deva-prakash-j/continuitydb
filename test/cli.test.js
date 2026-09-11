import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_LOCAL_MODEL } from "../src/local-embeddings.js";
import { ContextVault } from "../src/store.js";
import { VERSION } from "../src/version.js";

test("CLI version matches the package version", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-version-"));
  try {
    const cli = new URL("../src/cli.js", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.version, VERSION);
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(packageJson.version, VERSION);
    assert.equal(value.standalone, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup previews and applies all project agent connections idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-setup-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  mkdirSync(project);
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    const common = [cli, "setup", "--home", home, "--project-dir", project, "--agents", "all", "--owner", "owner-a"];
    const preview = spawnSync(process.execPath, common, { encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    const previewValue = JSON.parse(preview.stdout);
    assert.equal(previewValue.connections.length, 5);
    assert.deepEqual(previewValue.run, { command: "continuitydb", args: ["run", "--home", home] });
    assert.equal(existsSync(join(project, ".codex", "config.toml")), false);
    const applied = spawnSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).connections.every((item) => item.applied), true);
    const status = spawnSync(process.execPath, [cli, "agents", "status", "--home", home, "--project-dir", project], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).agents.filter((item) => item.connected).length, 5);
    const repeated = spawnSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).connections.every((item) => !item.changed), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup --agents all fails before mutating any client when a later config is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-setup-atomic-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const codex = join(project, ".codex", "config.toml");
  const claude = join(project, ".mcp.json");
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(codex, 'model = "gpt-5"\n');
  writeFileSync(claude, "{ malformed\n");
  const beforeCodex = readFileSync(codex, "utf8");
  const beforeClaude = readFileSync(claude, "utf8");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "all", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(codex, "utf8"), beforeCodex);
    assert.equal(readFileSync(claude, "utf8"), beforeClaude);
    assert.equal(existsSync(join(project, "opencode.json")), false);
    assert.equal(existsSync(join(project, ".cursor", "mcp.json")), false);
    assert.equal(existsSync(join(project, ".vscode", "mcp.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI agents connect all fails before mutating any client when a later namespace is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-connect-atomic-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const codex = join(project, ".codex", "config.toml");
  const claude = join(project, ".mcp.json");
  const opencode = join(project, "opencode.json");
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(codex, 'model = "gpt-5"\n');
  writeFileSync(claude, '{"keep":true}\n');
  writeFileSync(opencode, '{"mcp":"invalid"}\n');
  const before = new Map([codex, claude, opencode].map((path) => [path, readFileSync(path, "utf8")]));
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    const result = spawnSync(process.execPath, [
      cli, "agents", "connect", "all", "--home", home, "--project-dir", project, "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    for (const [path, content] of before) assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(existsSync(join(project, ".cursor", "mcp.json")), false);
    assert.equal(existsSync(join(project, ".vscode", "mcp.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --home overrides environment home for local embedding cache resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-home-test-"));
  const envHome = join(root, "environment-home");
  const cliHome = join(root, "cli-home");
  const linkTarget = join(root, "linked-model");
  mkdirSync(join(envHome, "models"), { recursive: true });
  mkdirSync(linkTarget, { recursive: true });
  symlinkSync(linkTarget, join(envHome, "models", BUILTIN_LOCAL_MODEL.cache_directory));
  const vault = new ContextVault(cliHome);
  const proposal = vault.propose({ body: "Create one active record that requires embedding." });
  vault.commit(proposal.record.id);
  vault.close();
  try {
    const cli = new URL("../src/cli.js", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "embeddings-index", "--home", cliHome], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTINUITYDB_HOME: envHome,
        CONTINUITYDB_EMBEDDING_PROVIDER: "local",
        CONTINUITYDB_LOCAL_MODEL_OFFLINE: "true",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not cached and offline mode is enabled/);
    assert.doesNotMatch(result.stderr, /real directory, not a symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI handoff-save quarantines a checkpoint without latest-checkpoint lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-handoff-test-"));
  const firstPath = join(root, "first.json");
  const conflictPath = join(root, "conflict.json");
  writeFileSync(firstPath, JSON.stringify({
    project_id: "api",
    task_id: "cli-rollout",
    checkpoint_id: "first",
    goal: "Ship safely",
    current_state: "Schema first",
    branch: "main",
  }));
  writeFileSync(conflictPath, JSON.stringify({
    project_id: "api",
    task_id: "cli-rollout",
    checkpoint_id: "conflict",
    goal: "Ship safely",
    current_state: "API first",
    branch: "main",
  }));
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const env = {
    ...process.env,
    CONTINUITYDB_ALLOWED_PROJECTS: "api",
    CONTINUITYDB_OWNER_ID: "owner-a",
    CONTINUITYDB_AGENT_ID: "agent-a",
  };
  try {
    const first = spawnSync(process.execPath, [cli, "handoff-save", "--home", root, "--file", firstPath], { encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).disposition, "active");
    const conflict = spawnSync(process.execPath, [cli, "handoff-save", "--home", root, "--file", conflictPath], { encoding: "utf8", env });
    assert.equal(conflict.status, 0, conflict.stderr);
    assert.equal(JSON.parse(conflict.stdout).disposition, "quarantined");
    const latest = spawnSync(process.execPath, [cli, "handoff-latest", "cli-rollout", "--home", root, "--project", "api", "--branch", "main"], { encoding: "utf8", env });
    assert.equal(latest.status, 0, latest.stderr);
    assert.equal(JSON.parse(latest.stdout).handoff.current_state, "Schema first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
