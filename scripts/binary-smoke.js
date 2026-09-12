#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateGeneratedAdapterTree } from "./validate-client-adapters.js";

const extension = process.platform === "win32" ? ".exe" : "";
const binary = resolve(process.env.CONTINUITYDB_BINARY_PATH || process.argv[2]
  || join("dist", `continuitydb-${process.platform}-${process.arch}${extension}`));
if (process.platform !== "win32") chmodSync(binary, 0o755);
const root = mkdtempSync(join(tmpdir(), "continuitydb-binary-smoke-"));
const project = join(root, "generic-repo");
const home = join(root, "vault");
const prefix = join(root, "prefix");
mkdirSync(join(project, ".git"), { recursive: true });

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

function runFailure(args, pattern) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
  assert.match(result.stderr, pattern);
  return result;
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

function assertFailedSetupPreservesVaultAndRetries(name, initialize) {
  const caseRoot = join(root, `rollback-${name}`);
  const caseProject = join(caseRoot, "project");
  const caseHome = join(caseRoot, "vault");
  const projectId = `binary-${name}`;
  mkdirSync(caseProject, { recursive: true });
  mkdirSync(caseHome, { recursive: true });
  let close = null;
  try {
    const lifecycle = initialize(caseHome);
    close = typeof lifecycle === "function" ? lifecycle : lifecycle?.close;
    mkdirSync(join(caseProject, ".codex"), { recursive: true });
    writeFileSync(join(caseProject, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(caseHome, "backups"), "pre-existing backup blocker\n");
    const before = snapshotTree(caseHome);
    const setupArgs = [
      "setup", "--home", caseHome, "--project-dir", caseProject,
      "--project", projectId, "--agents", "codex", "--apply",
    ];
    const result = spawnSync(binary, setupArgs, { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0, `${name} preservation probe unexpectedly succeeded`);
    assert.match(result.stderr, /backup parent must be a real directory/);
    assert.deepEqual(snapshotTree(caseHome), before, `${name} vault changed after failed setup`);

    rmSync(join(caseHome, "backups"));
    const retry = spawnSync(binary, setupArgs, { encoding: "utf8", timeout: 30_000 });
    assert.equal(retry.status, 0, `${name} retry failed: ${retry.stderr}`);
    const repeated = spawnSync(binary, setupArgs, { encoding: "utf8", timeout: 30_000 });
    assert.equal(repeated.status, 0, `${name} repeated setup failed: ${repeated.stderr}`);
    const config = JSON.parse(readFileSync(join(caseHome, "config.json"), "utf8"));
    assert.equal(config.projects.filter((project) => project.id === projectId && project.root === caseProject).length, 1);
    if (typeof lifecycle === "object") lifecycle.verify?.();
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
  const userAgents = "# User-owned agent instructions\n\nPreserve this byte-for-byte.  \n";
  const codexSeed = 'model = "binary-user-model"';
  writeFileSync(join(project, "AGENTS.md"), userAgents);
  mkdirSync(join(project, ".codex"));
  writeFileSync(join(project, ".codex", "config.toml"), codexSeed);
  const preview = run(["setup", "--home", home, "--project-dir", project, "--agents", "all"]);
  assert.equal(preview.applied, false);
  const setup = run(["setup", "--home", home, "--project-dir", project, "--agents", "all", "--apply"]);
  assert.equal(setup.connections.length, 5);
  assert.equal(setup.connections.every((item) => item.applied), true);
  assert.equal(setup.connections.every((item) => item.verified && item.assets.length >= 2), true);
  const standaloneAdapterValidation = validateGeneratedAdapterTree(project, {
    home,
    projectId: "generic-repo",
  });
  assert.equal(standaloneAdapterValidation.generated_assets, 12);
  const expectedAssets = [
    ".codex/config.toml", "AGENTS.md", ".mcp.json", ".claude/settings.json", "CLAUDE.md",
    "opencode.json", ".opencode/plugins/continuitydb.js", ".cursor/mcp.json", ".cursor/hooks.json",
    ".cursor/rules/continuitydb.mdc", ".vscode/mcp.json", ".github/copilot-instructions.md",
  ];
  for (const path of expectedAssets) {
    const absolute = join(project, path);
    assert.equal(existsSync(absolute), true, `missing complete adapter asset: ${path}`);
    assert.doesNotMatch(readFileSync(absolute, "utf8"), /(?:project scope: `default`|ALLOWED_PROJECTS\s*[=:]\s*["']default)/i);
  }
  for (const connection of setup.connections.filter((item) => !item.detected)) {
    assert.match(connection.limitations.join("\n"), /executable.*not detected.*PATH/i);
  }

  const codexConfig = join(project, ".codex", "config.toml");
  const postConnectToml = '[user_after_connect]\nkeep = "binary-user-byte"\n';
  writeFileSync(codexConfig, `${readFileSync(codexConfig, "utf8")}${postConnectToml}`);
  const updatedSetup = run(["setup", "--home", home, "--project-dir", project, "--agents", "all", "--apply"]);
  assert.equal(updatedSetup.connections.find((item) => item.client === "codex").changed, false);
  assert.equal(readFileSync(codexConfig, "utf8").endsWith(postConnectToml), true);
  assert.equal(run(["doctor", "--home", home]).ok, true);
  const healthyStatus = run(["agents", "status", "--home", home, "--project-dir", project]);
  assert.equal(healthyStatus.agents.filter((item) => item.connected && item.verified && !item.drifted).length, 5);

  const claudePolicy = join(project, "CLAUDE.md");
  const healthyClaudePolicy = readFileSync(claudePolicy, "utf8");
  writeFileSync(claudePolicy, healthyClaudePolicy.replace("compact durable claim", "drifted durable claim"));
  const driftStatus = run(["agents", "status", "--home", home, "--project-dir", project]);
  const driftedClaude = driftStatus.agents.find((item) => item.client === "claude");
  assert.equal(driftedClaude.connected, true);
  assert.equal(driftedClaude.drifted, true);
  assert.equal(driftedClaude.assets.find((item) => item.path === claudePolicy).changed, true);
  writeFileSync(claudePolicy, healthyClaudePolicy);

  const completeBeforeModeProbe = readFileSync(codexConfig, "utf8");
  runFailure([
    "agents", "connect", "codex", "--home", home, "--project-dir", project,
    "--mcp-only", "--apply",
  ], /mode.*disconnect|disconnect.*mode/i);
  runFailure([
    "agents", "disconnect", "codex", "--home", home, "--project-dir", project,
    "--mcp-only", "--apply",
  ], /mode mismatch|complete adapter/i);
  assert.equal(readFileSync(codexConfig, "utf8"), completeBeforeModeProbe);

  const copiedProject = join(root, "copied", "generic-repo");
  mkdirSync(join(root, "copied"));
  cpSync(project, copiedProject, { recursive: true });
  const copiedCodex = join(copiedProject, ".codex", "config.toml");
  const copiedBefore = readFileSync(copiedCodex, "utf8");
  const copiedStatus = run(["agents", "status", "--home", home, "--project-dir", copiedProject]);
  const copiedCodexStatus = copiedStatus.agents.find((item) => item.client === "codex");
  assert.equal(copiedCodexStatus.verified, false);
  assert.equal(copiedCodexStatus.drifted, true);
  assert.match(copiedCodexStatus.error, /registered.*root|not registered/i);
  assert.equal(readFileSync(copiedCodex, "utf8"), copiedBefore);

  const disconnected = run(["agents", "disconnect", "all", "--home", home, "--project-dir", project, "--apply"]);
  assert.equal(disconnected.results.every((item) => item.applied && item.verified), true);
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), userAgents);
  assert.equal(readFileSync(codexConfig, "utf8"), `${codexSeed}\n${postConnectToml}`);
  const disconnectRetry = run(["agents", "disconnect", "all", "--home", home, "--project-dir", project, "--apply"]);
  assert.equal(disconnectRetry.results.every((item) => !item.changed), true);

  const mcpOnly = run(["setup", "--home", home, "--project-dir", project, "--agents", "all", "--mcp-only", "--apply"]);
  assert.equal(mcpOnly.connections.every((item) => item.recall_mode === "mcp-only" && item.assets.length === 1), true);
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), userAgents);
  const mcpOnlyStatus = run(["agents", "status", "--home", home, "--project-dir", project]);
  assert.equal(mcpOnlyStatus.agents.filter((item) => item.connected && item.verified && item.recall_mode === "mcp-only").length, 5);
  const mcpOnlyBeforeModeProbe = readFileSync(codexConfig, "utf8");
  runFailure([
    "agents", "connect", "codex", "--home", home, "--project-dir", project, "--apply",
  ], /mode.*disconnect|disconnect.*mode/i);
  assert.equal(readFileSync(codexConfig, "utf8"), mcpOnlyBeforeModeProbe);
  const mcpOnlyDisconnected = run(["agents", "disconnect", "all", "--home", home, "--project-dir", project, "--mcp-only", "--apply"]);
  assert.equal(mcpOnlyDisconnected.results.every((item) => item.applied && item.verified), true);
  const mcpOnlyRetry = run(["agents", "disconnect", "all", "--home", home, "--project-dir", project, "--mcp-only", "--apply"]);
  assert.equal(mcpOnlyRetry.results.every((item) => !item.changed), true);
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), userAgents);
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

  assertFailedSetupPreservesVaultAndRetries("partial-home", (caseHome) => {
    mkdirSync(join(caseHome, "records", "nested"), { recursive: true });
    mkdirSync(join(caseHome, "index", "nested"), { recursive: true });
    writeFileSync(join(caseHome, "config.json"), '{\n    "schema_version": 2,\n    "binary_marker": "before"\n}\n');
    writeFileSync(join(caseHome, "records", "nested", "marker.bin"), Buffer.from([0, 1, 254, 255]));
    writeFileSync(join(caseHome, "index", "nested", "marker.txt"), "index-before\n");
    return {
      verify() {
        assert.equal(readFileSync(join(caseHome, "records", "nested", "marker.bin")).equals(Buffer.from([0, 1, 254, 255])), true);
        assert.equal(readFileSync(join(caseHome, "index", "nested", "marker.txt"), "utf8"), "index-before\n");
        assert.equal(JSON.parse(readFileSync(join(caseHome, "config.json"), "utf8")).binary_marker, "before");
      },
    };
  });
  assertFailedSetupPreservesVaultAndRetries("empty-index", (caseHome) => {
    mkdirSync(join(caseHome, "index"), { recursive: true });
  });
  assertFailedSetupPreservesVaultAndRetries("valid-db", (caseHome) => {
    run(["init", "--home", caseHome]);
  });
  if (process.platform !== "win32") {
    assertFailedSetupPreservesVaultAndRetries("wal-shm", (caseHome) => {
      run(["init", "--home", caseHome]);
      const database = new DatabaseSync(join(caseHome, "index", "context-vault.db"));
      database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rollback_probe(value TEXT); INSERT INTO rollback_probe VALUES ('before');");
      assert.equal(existsSync(join(caseHome, "index", "context-vault.db-wal")), true);
      assert.equal(existsSync(join(caseHome, "index", "context-vault.db-shm")), true);
      return {
        close: () => database.close(),
        verify: () => assert.equal(database.prepare("SELECT value FROM rollback_probe").get().value, "before"),
      };
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
      CONTINUITYDB_ALLOWED_PROJECTS: "generic-repo",
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
      arguments: { project_id: "generic-repo", memory_kind: "working", body: "StandaloneBinaryMarker is active." },
    });
    assert.equal(capture.structuredContent.disposition, "active");
    const search = await client.callTool({
      name: "memory_search",
      arguments: { project_id: "generic-repo", query: "StandaloneBinaryMarker" },
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
    checks: ["self-install", "setup", "five-complete-adapters", "standalone-adapter-validation", "codex-surgical-update", "status-drift", "status-project-root", "mode-transitions", "missing-executable-limitations", "mcp-only", "disconnect-retry", "doctor", "http-service", "setup-failure-retry", "mcp-tools", "capture-search"],
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
