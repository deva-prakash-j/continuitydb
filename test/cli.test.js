import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BUILTIN_LOCAL_MODEL } from "../src/local-embeddings.js";
import { ContextVault } from "../src/store.js";
import { VERSION } from "../src/version.js";

function snapshotTree(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const walk = (directory, relative = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const child = relative ? `${relative}/${name}` : name;
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        entries.push({ path: `${child}/`, type: "directory", mode: metadata.mode & 0o777 });
        walk(path, child);
      } else {
        assert.equal(metadata.isFile(), true, `unexpected non-regular setup artifact: ${child}`);
        entries.push({
          path: child,
          type: "file",
          mode: metadata.mode & 0o777,
          bytes: metadata.size,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  };
  walk(root);
  return entries;
}

function forceSetupConnectorFailure({ cli, home, project }) {
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
  writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");
  return spawnSync(process.execPath, [
    cli, "setup", "--home", home, "--project-dir", project, "--agents", "codex", "--apply",
  ], { encoding: "utf8" });
}

function waitForChildExit(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function waitForSetupSnapshot(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for setup snapshot")), 30_000);
    child.once("message", (message) => {
      clearTimeout(timeout);
      if (message?.type !== "continuitydb:setup-snapshot") {
        reject(new Error(`unexpected setup IPC message: ${JSON.stringify(message)}`));
        return;
      }
      resolve(message);
    });
  });
}

function waitForChildMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for child message ${type}`)), 30_000);
    const listener = (message) => {
      if (message?.type !== type) return;
      clearTimeout(timeout);
      child.off("message", listener);
      resolve(message);
    };
    child.on("message", listener);
    child.once("error", (error) => {
      clearTimeout(timeout);
      child.off("message", listener);
      reject(error);
    });
  });
}

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
    assert.equal(existsSync(home), false, "setup preview must not initialize the vault");
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
    assert.equal(existsSync(home), false, "failed connector preflight must not initialize the global vault");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup commit failure leaves no newly initialized vault artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-setup-commit-failure-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const codex = join(project, ".codex", "config.toml");
  const blockingBackupParent = join(home, "backups");
  mkdirSync(join(project, ".codex"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(codex, 'model = "gpt-5"\n');
  writeFileSync(blockingBackupParent, "pre-existing backup blocker\n");
  const beforeCodex = readFileSync(codex, "utf8");
  const beforeBlocker = readFileSync(blockingBackupParent, "utf8");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "all", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backup parent must be a real directory/);
    assert.equal(readFileSync(codex, "utf8"), beforeCodex);
    assert.equal(readFileSync(blockingBackupParent, "utf8"), beforeBlocker);
    assert.equal(existsSync(join(home, "config.json")), false);
    assert.equal(existsSync(join(home, "records")), false);
    assert.equal(existsSync(join(home, "index")), false);
    assert.equal(existsSync(join(project, ".mcp.json")), false);
    assert.equal(existsSync(join(project, "opencode.json")), false);
    assert.equal(existsSync(join(project, ".cursor", "mcp.json")), false);
    assert.equal(existsSync(join(project, ".vscode", "mcp.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI failed setup restores a pre-existing empty index directory byte-for-byte", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-empty-index-rollback-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(join(home, "index"), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");
    const before = snapshotTree(home);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backup parent must be a real directory/);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI failed setup restores a pre-existing valid vault database byte-for-byte", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-valid-db-rollback-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(project);
    const init = spawnSync(process.execPath, [cli, "init", "--home", home], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");
    const before = snapshotTree(home);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI failed setup restores live SQLite WAL and SHM sidecars on POSIX", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-wal-rollback-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  let database;
  try {
    mkdirSync(project);
    const init = spawnSync(process.execPath, [cli, "init", "--home", home], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    database = new DatabaseSync(join(home, "index", "context-vault.db"));
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rollback_probe(value TEXT); INSERT INTO rollback_probe VALUES ('before');");
    assert.equal(existsSync(join(home, "index", "context-vault.db-wal")), true);
    assert.equal(existsSync(join(home, "index", "context-vault.db-shm")), true);
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");
    const before = snapshotTree(home);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI failed setup serializes a concurrent first-open commit and preserves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-concurrent-rollback-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  let reopened;
  let writer;
  try {
    mkdirSync(join(home, "index"), { recursive: true });
    mkdirSync(project);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");

    const child = fork(cli, [
      "setup", "--home", home, "--project-dir", project, "--agents", "codex", "--apply",
    ], {
      env: { ...process.env, NODE_ENV: "test", CONTINUITYDB_TEST_SETUP_SNAPSHOT_SYNC: "1" },
      silent: true,
    });
    const exit = waitForChildExit(child);
    const snapshot = await waitForSetupSnapshot(child);
    assert.equal(existsSync(snapshot.directory), true);

    const worker = new URL("../test-support/concurrent-first-commit.mjs", import.meta.url).pathname;
    writer = fork(worker, [], { silent: true });
    await waitForChildMessage(writer, "ready");
    const starting = waitForChildMessage(writer, "starting");
    const committed = waitForChildMessage(writer, "committed");
    writer.send({ type: "commit", home, cli });
    await starting;
    // The writer is now waiting on the setup initialization lock. Resume the
    // failed setup; rollback completes before the first-open writer proceeds.
    child.send("continuitydb:resume-setup");

    const result = await exit;
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(result.stderr, /backup parent must be a real directory/);
    const committedMessage = await committed;

    reopened = new ContextVault(home);
    assert.equal(reopened.get(committedMessage.id)?.body, committedMessage.body, "first-open commit must survive failed setup");
  } finally {
    if (writer?.connected) writer.disconnect();
    reopened?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup vault failure occurs before agent commit and removes new setup artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-setup-vault-failure-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const codex = join(project, ".codex", "config.toml");
  const blocker = join(home, "index");
  mkdirSync(join(project, ".codex"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(codex, 'model = "gpt-5"\n');
  writeFileSync(blocker, "pre-existing index blocker\n");
  const beforeCodex = readFileSync(codex, "utf8");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "all", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(codex, "utf8"), beforeCodex);
    assert.equal(readFileSync(blocker, "utf8"), "pre-existing index blocker\n");
    assert.equal(existsSync(join(home, "config.json")), false);
    assert.equal(existsSync(join(home, "records")), false);
    assert.equal(existsSync(join(project, ".mcp.json")), false);
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
