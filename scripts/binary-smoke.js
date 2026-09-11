#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const extension = process.platform === "win32" ? ".exe" : "";
const binary = resolve(process.env.CONTINUITYDB_BINARY_PATH || process.argv[2]
  || join("dist", `continuitydb-${process.platform}-${process.arch}${extension}`));
if (process.platform !== "win32") chmodSync(binary, 0o755);
const root = mkdtempSync(join(tmpdir(), "continuitydb-binary-smoke-"));
const project = join(root, "project");
const home = join(root, "vault");
const prefix = join(root, "prefix");
mkdirSync(project);

function run(args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: result.stdout,
    stderr: result.stderr,
  })}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function snapshotTree(directory) {
  const entries = [];
  const walk = (root, relative = "") => {
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name);
      const child = relative ? `${relative}/${name}` : name;
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        entries.push({ path: `${child}/`, type: "directory", mode: metadata.mode & 0o777 });
        walk(path, child);
      } else {
        assert.equal(metadata.isFile(), true, `unexpected non-regular vault entry: ${child}`);
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
  walk(directory);
  return entries;
}

function assertFailedSetupRestoresVault(name, initialize) {
  const caseRoot = join(root, `rollback-${name}`);
  const caseProject = join(caseRoot, "project");
  const caseHome = join(caseRoot, "vault");
  mkdirSync(caseProject, { recursive: true });
  mkdirSync(caseHome, { recursive: true });
  let close = null;
  try {
    close = initialize(caseHome);
    mkdirSync(join(caseProject, ".codex"), { recursive: true });
    writeFileSync(join(caseProject, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(caseHome, "backups"), "pre-existing backup blocker\n");
    const before = snapshotTree(caseHome);
    const result = spawnSync(binary, [
      "setup", "--home", caseHome, "--project-dir", caseProject, "--agents", "codex", "--apply",
    ], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0, `${name} rollback probe unexpectedly succeeded`);
    assert.match(result.stderr, /backup parent must be a real directory/);
    assert.deepEqual(snapshotTree(caseHome), before, `${name} vault changed after failed setup`);
  } finally {
    close?.();
  }
}

async function proveHttpService(expectedVersion) {
  const child = spawn(binary, ["run", "--home", home, "--host", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const address = await new Promise((resolveAddress, reject) => {
      const timeout = setTimeout(() => reject(new Error(`service readiness timed out: ${stderr}`)), 10_000);
      const inspect = () => {
        const match = stderr.match(/ContinuityDB ready at (127\.0\.0\.1|::1):(\d+)/);
        if (!match) return;
        clearTimeout(timeout);
        resolveAddress(`http://127.0.0.1:${match[2]}`);
      };
      child.stderr.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`service exited before readiness with ${code}: ${stderr}`));
      });
      inspect();
    });
    const response = await fetch(`${address}/healthz`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.status, "ok");
    assert.equal(health.version, expectedVersion);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    });
  }
}

try {
  const version = run(["version"]);
  assert.equal(version.standalone, true);
  const preview = run(["setup", "--home", home, "--project-dir", project, "--agents", "all"]);
  assert.equal(preview.applied, false);
  const setup = run(["setup", "--home", home, "--project-dir", project, "--agents", "all", "--apply"]);
  assert.equal(setup.connections.length, 5);
  assert.equal(setup.connections.every((item) => item.applied), true);
  assert.equal(run(["doctor", "--home", home]).ok, true);
  assert.equal(run(["agents", "status", "--home", home, "--project-dir", project]).agents.filter((item) => item.connected).length, 5);
  const installation = run(["install", "--prefix", prefix, "--apply"]);
  assert.equal(installation.installed, true);
  const installedResult = spawnSync(installation.launcher, ["version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(installedResult.status, 0, JSON.stringify({
    status: installedResult.status,
    signal: installedResult.signal,
    error: installedResult.error ? { code: installedResult.error.code, message: installedResult.error.message } : null,
    stdout: installedResult.stdout,
    stderr: installedResult.stderr,
  }));
  assert.equal(JSON.parse(installedResult.stdout).version, version.version);
  await proveHttpService(version.version);

  assertFailedSetupRestoresVault("empty-index", (caseHome) => {
    mkdirSync(join(caseHome, "index"), { recursive: true });
  });
  assertFailedSetupRestoresVault("valid-db", (caseHome) => {
    run(["init", "--home", caseHome]);
  });
  if (process.platform !== "win32") {
    assertFailedSetupRestoresVault("wal-shm", (caseHome) => {
      run(["init", "--home", caseHome]);
      const database = new DatabaseSync(join(caseHome, "index", "context-vault.db"));
      database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rollback_probe(value TEXT); INSERT INTO rollback_probe VALUES ('before');");
      assert.equal(existsSync(join(caseHome, "index", "context-vault.db-wal")), true);
      assert.equal(existsSync(join(caseHome, "index", "context-vault.db-shm")), true);
      return () => database.close();
    });
  }

  const transport = new StdioClientTransport({
    command: binary,
    args: ["mcp", "--home", home],
    env: {
      ...process.env,
      CONTINUITYDB_TENANT_ID: "binary-smoke",
      CONTINUITYDB_PRINCIPAL_ID: "binary-smoke-agent",
      CONTINUITYDB_OWNER_ID: "binary-smoke-owner",
      CONTINUITYDB_AGENT_ID: "binary-smoke",
      CONTINUITYDB_ALLOWED_PROJECTS: "project",
      CONTINUITYDB_ALLOWED_SENSITIVITIES: "public,private",
    },
  });
  const client = new Client({ name: "continuitydb-binary-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, version.version);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
    const capture = await client.callTool({
      name: "memory_capture",
      arguments: { project_id: "project", memory_kind: "working", body: "StandaloneBinaryMarker is active." },
    });
    assert.equal(capture.structuredContent.disposition, "active");
    const search = await client.callTool({
      name: "memory_search",
      arguments: { project_id: "project", query: "StandaloneBinaryMarker" },
    });
    assert.equal(search.structuredContent.results.length, 1);
  } finally {
    await client.close();
  }
  process.stdout.write(`${JSON.stringify({
    passed: true,
    binary,
    version: version.version,
    platform: version.platform,
    arch: version.arch,
    checks: ["self-install", "setup", "doctor", "five-agent-config", "http-service", "setup-rollback", "mcp-tools", "capture-search"],
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
