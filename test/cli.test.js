import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseToml } from "smol-toml";
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
    cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "codex", "--apply",
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

function setupArguments({ cli, home, project, agents = "codex" }) {
  return [
    cli, "setup", "--home", home, "--project-dir", project,
    "--project", "cli-test", "--agents", agents, "--apply",
  ];
}

function runSetupAtFailpoint({ cli, home, project, failpoint, agents }) {
  return spawnSync(process.execPath, setupArguments({ cli, home, project, agents }), {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      CONTINUITYDB_TEST_SETUP_FAILPOINT: failpoint,
    },
  });
}

function assertProjectRegisteredOnce(home, project) {
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.projects.filter((item) => item.id === "cli-test" && item.root === project).length, 1);
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
    const common = [cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "all", "--owner", "owner-a"];
    const preview = spawnSync(process.execPath, common, { encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    const previewValue = JSON.parse(preview.stdout);
    assert.equal(previewValue.connections.length, 5);
    assert.deepEqual(previewValue.project, {
      id: "cli-test", root: project, source: "explicit", git_root: null,
    });
    assert.deepEqual(previewValue.agents.selected, ["codex", "claude", "opencode", "cursor", "copilot"]);
    assert.deepEqual(previewValue.agents.planned, ["codex", "claude", "opencode", "cursor", "copilot"]);
    assert.deepEqual(previewValue.agents.connected, []);
    assert.equal(previewValue.agents.requested, "all");
    assert.equal(previewValue.configuration_scope, "project");
    assert.deepEqual(previewValue.run, { command: "continuitydb", args: ["run", "--home", home] });
    assert.equal(existsSync(join(project, ".codex", "config.toml")), false);
    assert.equal(existsSync(home), false, "setup preview must not initialize the vault");
    const applied = spawnSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    const appliedValue = JSON.parse(applied.stdout);
    assert.equal(appliedValue.connections.every((item) => item.applied), true);
    assert.deepEqual(appliedValue.project, previewValue.project);
    assert.deepEqual(appliedValue.agents.selected, previewValue.agents.selected);
    assert.deepEqual(appliedValue.agents.planned, []);
    assert.deepEqual(appliedValue.agents.connected, previewValue.agents.selected);
    assert.equal(appliedValue.configuration_scope, "project");
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

test("CLI setup reports a filesystem-detected OpenCode-only project connection", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-detected-summary-"));
  const project = join(root, "billing-api");
  const home = join(root, "vault");
  const bin = join(root, "bin");
  const userHome = join(root, "user-home");
  const executionMarker = join(root, "opencode-executed");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(bin);
    mkdirSync(userHome);
    writeFileSync(join(bin, "opencode"), `#!/bin/sh\nprintf executed > ${executionMarker}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "detected",
    ], { encoding: "utf8", env: { ...process.env, PATH: bin, HOME: userHome, USERPROFILE: userHome } });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.project, {
      id: "billing-api", root: project, source: "git", git_root: project,
    });
    assert.deepEqual(value.agents, {
      requested: "detected",
      detected: ["opencode"],
      selected: ["opencode"],
      planned: ["opencode"],
      connected: [],
      supported_not_installed: ["codex", "claude", "cursor", "copilot"],
    });
    assert.equal(value.configuration_scope, "project");
    assert.equal(value.connections.length, 1);
    assert.equal(value.connections[0].client, "opencode");
    assert.equal(value.connections[0].path, join(project, "opencode.json"));
    assert.equal(existsSync(join(project, "opencode.json")), false);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(executionMarker), false, "detected client binaries must never execute");
    assert.deepEqual(readdirSync(userHome), [], "setup preview must not create global client configuration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup derives one Git project identity and registers it on apply", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-git-setup-"));
  const project = join(root, "git-project");
  const nested = join(project, "packages", "worker");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    const common = [cli, "setup", "--home", home, "--project-dir", nested, "--agents", "codex"];
    const preview = spawnSync(process.execPath, common, { encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).registration, {
      changed: true,
      applied: false,
      projects: [{ id: "git-project", root: project, source: "git" }],
    });
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(join(nested, ".codex", "config.toml")), false);

    const applied = spawnSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).registration.applied, true);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).projects, [
      { id: "git-project", root: project, source: "git" },
    ]);
    assert.match(readFileSync(join(nested, ".codex", "config.toml"), "utf8"), /CONTINUITYDB_ALLOWED_PROJECTS = "git-project"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup authorizes the exact AgentForge Git identity without a default fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-agentforge-"));
  const project = join(root, "AgentForge");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  let client;
  try {
    mkdirSync(join(project, ".git"), { recursive: true });
    const setup = spawnSync(process.execPath, [
      cli,
      "setup",
      "--home",
      home,
      "--project-dir",
      project,
      "--agents",
      "codex",
      "--binary",
      cli,
      "--apply",
    ], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).projects, [
      { id: "AgentForge", root: project, source: "git" },
    ]);

    const connector = parseToml(readFileSync(join(project, ".codex", "config.toml"), "utf8"));
    const server = connector.mcp_servers.continuitydb;
    assert.equal(server.env.CONTINUITYDB_ALLOWED_PROJECTS, "AgentForge");
    assert.equal(server.env.CONTINUITYDB_ALLOWED_PROJECTS.includes("default"), false);

    client = new Client({ name: "agentforge-regression", version: "0.7.0" });
    const ambientEnvironment = {
      ...process.env,
      CONTINUITYDB_ALLOWED_PROJECTS: "ambient-project",
      CONTINUITYDB_ALLOWED_SENSITIVITIES: "restricted",
      CONTINUITYDB_CAPTURE_POLICY_FILE: join(root, "hostile-ambient-policy.json"),
      CONTINUITYDB_TENANT_ID: "ambient-tenant",
      CONTINUITYDB_PRINCIPAL_ID: "ambient-principal",
      CONTINUITYDB_OWNER_ID: "ambient-owner",
      CONTINUITYDB_AGENT_ID: "ambient-agent",
      CONTINUITYDB_MCP_SCOPES: "memory:read",
      CONTINUITYDB_MCP_CAPTURE_BURST: "0",
      CONTINUITYDB_MCP_CAPTURE_PER_SECOND: "0",
      CONTINUITYDB_HTTP_URL: "https://ambient.invalid",
      CONTEXT_VAULT_ALLOWED_PROJECTS: "legacy-ambient-project",
    };
    const isolatedEnvironment = Object.fromEntries(Object.entries(ambientEnvironment).filter(([key]) => (
      !key.startsWith("CONTINUITYDB_") && !key.startsWith("CONTEXT_VAULT_")
    )));
    assert.equal(isolatedEnvironment.CONTINUITYDB_CAPTURE_POLICY_FILE, undefined);
    assert.equal(isolatedEnvironment.CONTINUITYDB_MCP_SCOPES, undefined);
    assert.equal(isolatedEnvironment.CONTINUITYDB_HTTP_URL, undefined);
    assert.equal(isolatedEnvironment.CONTEXT_VAULT_ALLOWED_PROJECTS, undefined);
    await client.connect(new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...isolatedEnvironment, ...server.env, CONTINUITYDB_EMBEDDING_PROVIDER: "none" },
    }));
    const captured = await client.callTool({
      name: "memory_capture",
      arguments: {
        project_id: "AgentForge",
        memory_kind: "working",
        body: "AgentForge keeps the platform architecture context in ContinuityDB.",
      },
    });
    assert.equal(captured.structuredContent.disposition, "active");
    assert.equal(captured.structuredContent.record.project_id, "AgentForge");
    const forbidden = await client.callTool({
      name: "memory_capture",
      arguments: {
        project_id: "unregistered-project",
        memory_kind: "working",
        body: "NeverAuthorizedScopeSentinel must not be captured.",
      },
    });
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /project unregistered-project is not allowed for this caller/i);
    const omitted = await client.callTool({
      name: "memory_capture",
      arguments: {
        memory_kind: "working",
        body: "Omitting project_id must not fall back to default.",
      },
    });
    assert.equal(omitted.isError, true);
    assert.match(omitted.content[0].text, /project_id|required/i);
    const searched = await client.callTool({
      name: "memory_search",
      arguments: { query: "NeverAuthorizedScopeSentinel", project_id: "AgentForge" },
    });
    assert.deepEqual(searched.structuredContent.results, []);
  } finally {
    await client?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup outside Git refuses before mutating the vault or project", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-outside-git-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(project);
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot infer a project identity.*--project <id>/i);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(join(project, ".codex", "config.toml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup accepts and registers an explicit project outside Git", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-explicit-setup-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(project);
    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--project", "billing-api", "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).projects, [
      { id: "billing-api", root: project, source: "explicit" },
    ]);
    assert.match(readFileSync(join(project, ".codex", "config.toml"), "utf8"), /CONTINUITYDB_ALLOWED_PROJECTS = "billing-api"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI projects add previews, applies, lists, and repeats idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-projects-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(project);
    const common = [cli, "projects", "add", "--home", home, "--project-dir", project, "--project", "billing-api"];
    const preview = spawnSync(process.execPath, common, { encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout), {
      project: { id: "billing-api", root: project, source: "explicit", git_root: null },
      changed: true,
      applied: false,
      projects: [{ id: "billing-api", root: project, source: "explicit" }],
    });
    assert.equal(existsSync(home), false);

    const applied = spawnSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).changed, true);
    const repeated = spawnSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).changed, false);
    const listed = spawnSync(process.execPath, [cli, "projects", "list", "--home", home], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), {
      projects: [{ id: "billing-api", root: project, source: "explicit" }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup connector failure restores exact config bytes and registry state", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-registry-rollback-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(project);
    const init = spawnSync(process.execPath, [cli, "init", "--home", home], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects = [{ id: "existing", root: join(root, "existing"), source: "explicit" }];
    config.unknown_extension = { preserve: true };
    const before = Buffer.from(`${JSON.stringify(config, null, 4)}\n`);
    writeFileSync(configPath, before);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");

    const result = spawnSync(process.execPath, [
      cli, "setup", "--home", home, "--project-dir", project, "--project", "new-project", "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backup parent must be a real directory/);
    assert.equal(readFileSync(configPath).equals(before), true, "rollback must restore the exact prior config bytes");
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
      cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "all", "--apply",
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
      cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "all", "--apply",
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

test("CLI connector failure preserves a partial vault when setup staging is destroyed", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-no-restore-source-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const config = Buffer.from('{\n    "schema_version": 2,\n    "private_marker": "config-before"\n}\n');
  const recordsMarker = Buffer.from([0, 1, 2, 3, 254, 255]);
  const indexMarker = Buffer.from("index-before\n");
  const modelMarker = Buffer.from("model-before\n");
  try {
    mkdirSync(join(home, "records", "nested"), { recursive: true });
    mkdirSync(join(home, "index", "nested"), { recursive: true });
    mkdirSync(join(home, "models", "private-cache"), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(home, "config.json"), config);
    writeFileSync(join(home, "records", "nested", "marker.bin"), recordsMarker);
    writeFileSync(join(home, "index", "nested", "marker.txt"), indexMarker);
    writeFileSync(join(home, "models", "private-cache", "marker.txt"), modelMarker);
    writeFileSync(join(home, "unrelated.bin"), Buffer.from([9, 8, 7, 6]));
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");
    const before = snapshotTree(home);

    const child = fork(cli, setupArguments({ cli, home, project }).slice(1), {
      env: { ...process.env, NODE_ENV: "test", CONTINUITYDB_TEST_SETUP_SNAPSHOT_SYNC: "1" },
      silent: true,
    });
    const exit = waitForChildExit(child);
    const staging = await waitForSetupSnapshot(child);
    rmSync(staging.directory, { recursive: true, force: true });
    child.send("continuitydb:resume-setup");

    const result = await exit;
    assert.notEqual(result.code, 0, result.stderr);
    assert.deepEqual(snapshotTree(home), before);
    assert.equal(readFileSync(join(home, "config.json")).equals(config), true);
    assert.equal(readFileSync(join(home, "records", "nested", "marker.bin")).equals(recordsMarker), true);
    assert.equal(readFileSync(join(home, "index", "nested", "marker.txt")).equals(indexMarker), true);
    assert.equal(readFileSync(join(home, "models", "private-cache", "marker.txt")).equals(modelMarker), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI failed setup never passes a pre-existing canonical path to recursive removal", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-removal-trace-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const removalLog = join(root, "recursive-removals.jsonl");
  const preload = join(root, "trace-removals.cjs");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(join(home, "records", "nested"), { recursive: true });
    mkdirSync(join(home, "index", "nested"), { recursive: true });
    mkdirSync(join(home, "models", "private-cache"), { recursive: true });
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(home, "config.json"), '{"schema_version":2,"marker":"before"}\n');
    writeFileSync(join(home, "records", "nested", "marker.txt"), "records-before\n");
    writeFileSync(join(home, "index", "nested", "marker.txt"), "index-before\n");
    writeFileSync(join(home, "models", "private-cache", "marker.txt"), "model-before\n");
    writeFileSync(join(home, "backups"), "pre-existing backup blocker\n");
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(preload, [
      '"use strict";',
      'const fs = require("node:fs");',
      'const { syncBuiltinESMExports } = require("node:module");',
      'const originalRmSync = fs.rmSync;',
      'fs.rmSync = function continuitydbTracedRmSync(path, options) {',
      '  if (options && options.recursive) fs.appendFileSync(process.env.CONTINUITYDB_TEST_RM_LOG, `${JSON.stringify(String(path))}\\n`);',
      '  return originalRmSync(path, options);',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join("\n"));

    const result = spawnSync(process.execPath, setupArguments({ cli, home, project }), {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTINUITYDB_TEST_RM_LOG: removalLog,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require", preload].filter(Boolean).join(" "),
      },
    });
    assert.notEqual(result.status, 0, result.stderr);
    const recursivelyRemoved = existsSync(removalLog)
      ? readFileSync(removalLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    const protectedPaths = [
      join(home, "config.json"),
      join(home, "records"),
      join(home, "index"),
      join(home, "models"),
    ];
    assert.deepEqual(
      recursivelyRemoved.filter((path) => protectedPaths.includes(path)),
      [],
      `pre-existing canonical setup paths were recursively removed: ${JSON.stringify(recursivelyRemoved)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI existing-home promotion failures roll connectors back and retry without duplicate registration", async (t) => {
  const scenarios = [
    {
      name: "missing records and index",
      failpoints: ["before-records", "after-records", "before-index", "after-index", "before-config", "after-config"],
      seed(home) {
        mkdirSync(home, { recursive: true });
      },
    },
    {
      name: "missing database in an existing index",
      failpoints: ["before-database", "after-database", "before-config", "after-config"],
      seed(home) {
        mkdirSync(join(home, "records", "nested"), { recursive: true });
        mkdirSync(join(home, "index", "nested"), { recursive: true });
        writeFileSync(join(home, "records", "nested", "marker.txt"), "records-before\n");
        writeFileSync(join(home, "index", "nested", "marker.txt"), "index-before\n");
      },
    },
  ];

  for (const scenario of scenarios) {
    for (const failpoint of scenario.failpoints) {
      await t.test(`${scenario.name}: ${failpoint}`, () => {
        const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-promotion-failure-"));
        const project = join(root, "project");
        const home = join(root, "vault");
        const cli = new URL("../src/cli.js", import.meta.url).pathname;
        const config = Buffer.from('{\n    "schema_version": 2,\n    "extension": { "preserve": true }\n}\n');
        const connector = Buffer.from('model = "gpt-5"\n');
        try {
          scenario.seed(home);
          mkdirSync(join(project, ".codex"), { recursive: true });
          writeFileSync(join(home, "config.json"), config);
          writeFileSync(join(home, "unrelated.bin"), Buffer.from([5, 4, 3, 2, 1]));
          writeFileSync(join(project, ".codex", "config.toml"), connector);

          const agents = scenario.name === "missing records and index" && failpoint === "before-config" ? "all" : "codex";
          const failed = runSetupAtFailpoint({ cli, home, project, failpoint, agents });
          assert.notEqual(failed.status, 0, `${failpoint} unexpectedly succeeded`);
          assert.match(failed.stderr, new RegExp(`injected setup failure at ${failpoint}`));
          assert.equal(readFileSync(join(home, "config.json")).equals(config), true, "pre-existing config bytes changed");
          assert.equal(readFileSync(join(home, "unrelated.bin")).equals(Buffer.from([5, 4, 3, 2, 1])), true);
          assert.equal(readFileSync(join(project, ".codex", "config.toml")).equals(connector), true, "connector was not rolled back");
          if (agents === "all") {
            assert.equal(existsSync(join(project, ".mcp.json")), false);
            assert.equal(existsSync(join(project, "opencode.json")), false);
            assert.equal(existsSync(join(project, ".cursor", "mcp.json")), false);
            assert.equal(existsSync(join(project, ".vscode", "mcp.json")), false);
          }
          if (scenario.name.includes("existing index")) {
            assert.equal(readFileSync(join(home, "records", "nested", "marker.txt"), "utf8"), "records-before\n");
            assert.equal(readFileSync(join(home, "index", "nested", "marker.txt"), "utf8"), "index-before\n");
          }

          const retry = spawnSync(process.execPath, setupArguments({ cli, home, project, agents }), { encoding: "utf8" });
          assert.equal(retry.status, 0, retry.stderr);
          assertProjectRegisteredOnce(home, project);
          const repeated = spawnSync(process.execPath, setupArguments({ cli, home, project, agents }), { encoding: "utf8" });
          assert.equal(repeated.status, 0, repeated.stderr);
          assertProjectRegisteredOnce(home, project);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("CLI fresh-home promotion failures are atomic and retry idempotently", async (t) => {
  for (const failpoint of ["before-home", "after-home"]) {
    await t.test(failpoint, () => {
      const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-fresh-promotion-"));
      const project = join(root, "project");
      const home = join(root, "vault");
      const cli = new URL("../src/cli.js", import.meta.url).pathname;
      const connector = Buffer.from('model = "gpt-5"\n');
      try {
        mkdirSync(join(project, ".codex"), { recursive: true });
        writeFileSync(join(project, ".codex", "config.toml"), connector);

        const failed = runSetupAtFailpoint({ cli, home, project, failpoint });
        assert.notEqual(failed.status, 0, `${failpoint} unexpectedly succeeded`);
        assert.match(failed.stderr, new RegExp(`injected setup failure at ${failpoint}`));
        assert.equal(readFileSync(join(project, ".codex", "config.toml")).equals(connector), true);
        if (failpoint === "before-home") assert.equal(existsSync(home), false);

        const retry = spawnSync(process.execPath, setupArguments({ cli, home, project }), { encoding: "utf8" });
        assert.equal(retry.status, 0, retry.stderr);
        assertProjectRegisteredOnce(home, project);
        const repeated = spawnSync(process.execPath, setupArguments({ cli, home, project }), { encoding: "utf8" });
        assert.equal(repeated.status, 0, repeated.stderr);
        assertProjectRegisteredOnce(home, project);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
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
      cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "codex", "--apply",
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
      cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI setup refuses to place a new database beside pre-existing WAL or SHM state", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-orphan-sidecars-"));
  const project = join(root, "project");
  const home = join(root, "vault");
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  try {
    mkdirSync(join(home, "index"), { recursive: true });
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(home, "index", "context-vault.db-wal"), Buffer.from([1, 3, 3, 7]));
    writeFileSync(join(home, "index", "context-vault.db-shm"), Buffer.from([9, 2, 5, 6]));
    writeFileSync(join(project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    const before = snapshotTree(home);

    const result = spawnSync(process.execPath, setupArguments({ cli, home, project }), { encoding: "utf8" });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /sidecar.*without.*database/i);
    assert.deepEqual(snapshotTree(home), before);
    assert.equal(readFileSync(join(project, ".codex", "config.toml"), "utf8"), 'model = "gpt-5"\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI failed setup preserves live SQLite WAL and SHM state across restart", { skip: process.platform === "win32" }, () => {
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
      cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "codex", "--apply",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshotTree(home), before);
    database.close();
    database = new DatabaseSync(join(home, "index", "context-vault.db"));
    assert.equal(database.prepare("SELECT value FROM rollback_probe").get().value, "before");
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
      "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "codex", "--apply",
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
      cli, "setup", "--home", home, "--project-dir", project, "--project", "cli-test", "--agents", "all", "--apply",
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
      cli, "agents", "connect", "all", "--home", home, "--project-dir", project, "--project", "cli-test", "--apply",
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
