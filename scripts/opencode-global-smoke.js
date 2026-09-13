#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extension = process.platform === "win32" ? ".exe" : "";
const binary = resolve(process.env.CONTINUITYDB_BINARY_PATH || process.argv[2]
  || join("dist", `continuitydb-${process.platform}-${process.arch}${extension}`));
const nativeOpenCode = {
  "linux-x64": join("node_modules", "opencode-linux-x64", "bin", "opencode"),
  "darwin-arm64": join("node_modules", "opencode-darwin-arm64", "bin", "opencode"),
  "win32-x64": join("node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
}[`${process.platform}-${process.arch}`];
assert.ok(nativeOpenCode || process.env.OPENCODE_BINARY_PATH,
  `unsupported OpenCode native smoke target: ${process.platform}-${process.arch}`);
const opencode = resolve(process.env.OPENCODE_BINARY_PATH || nativeOpenCode);
if (process.platform !== "win32") {
  chmodSync(binary, 0o755);
  chmodSync(opencode, 0o755);
}

const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-native-"));
const workspaceOne = join(root, "workspace-one");
const workspaceTwo = join(root, "workspace-two");
const repoOne = join(workspaceOne, "service");
const repoTwo = join(workspaceTwo, "service");
const configRoot = join(root, "config");
const configDir = join(configRoot, "opencode");
const home = join(root, "vault");

function result(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 45_000,
    windowsHide: true,
    ...options,
  });
}

function succeed(command, args, options = {}) {
  const completed = result(command, args, options);
  assert.equal(completed.status, 0, `${command} ${args.join(" ")} failed: ${JSON.stringify({
    status: completed.status,
    signal: completed.signal,
    error: completed.error?.message || null,
    stdout: completed.stdout,
    stderr: completed.stderr,
  })}`);
  return completed.stdout.trim() ? JSON.parse(completed.stdout) : null;
}

function opencodeEnvironment() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    HOME: root,
    USERPROFILE: root,
  };
}

function openRepository(repository) {
  return succeed(opencode, ["debug", "config"], {
    cwd: repository,
    env: opencodeEnvironment(),
  });
}

async function loadInstalledPlugin() {
  // OpenCode has already loaded and validated this exact global plugin. Make its
  // pinned SDK dependency resolvable to Node so the smoke can invoke the same
  // registered handler definitions without requiring a model/provider credential.
  const packageTarget = join(configRoot, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(join(configRoot, "node_modules", "@opencode-ai"), { recursive: true });
  cpSync(fileURLToPath(new URL("../node_modules/@opencode-ai/plugin/", import.meta.url)), packageTarget, {
    recursive: true,
  });
  writeFileSync(join(configDir, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
  const installedPlugin = join(configDir, "plugins", "continuitydb.js");
  const module = await import(`${pathToFileURL(installedPlugin).href}?native-smoke=${Date.now()}`);
  assert.equal(typeof module.ContinuityDBGlobalPlugin, "function");
  return module.ContinuityDBGlobalPlugin;
}

try {
  for (const repository of [repoOne, repoTwo]) {
    mkdirSync(repository, { recursive: true });
    succeed("git", ["init", "-q"], { cwd: repository });
  }

  const installed = succeed(binary, [
    "opencode", "install",
    "--workspace-root", workspaceOne,
    "--workspace-root", workspaceTwo,
    "--opencode-config-dir", configDir,
    "--home", home,
    "--apply",
  ]);
  assert.equal(installed.verified, true);
  assert.deepEqual(installed.workspace_roots, [workspaceOne, workspaceTwo]);

  for (const repository of [repoOne, repoTwo]) {
    const config = openRepository(repository);
    assert.equal(config.permission?.["continuitydb_*"], "allow");
    assert.equal(config.plugin_origins?.some((origin) => origin.scope === "global"
      && origin.spec.includes("continuitydb.js")), true);
  }

  const projects = succeed(binary, ["projects", "list", "--home", home]).projects;
  assert.equal(projects.length, 2);
  assert.equal(projects[0].id, "service");
  assert.match(projects[1].id, /^service-[a-f0-9]{12}$/);
  assert.equal(projects.some((project) => project.id === "default"), false);

  const ContinuityDBGlobalPlugin = await loadInstalledPlugin();
  for (const [index, project] of projects.entries()) {
    const marker = `OpenCodeNativeMemory${index + 1}`;
    const hooks = await ContinuityDBGlobalPlugin({
      directory: project.root,
      worktree: process.platform === "win32" ? "C:\\" : "/",
      client: { app: { log: async () => ({}) } },
    });
    const context = {
      directory: project.root,
      worktree: process.platform === "win32" ? "C:\\" : "/",
      sessionID: `native-smoke-${index + 1}`,
    };
    const captured = JSON.parse(await hooks.tool.continuitydb_remember.execute({
      body: `${marker} is active.`,
      kind: "working",
      sensitivity: "private",
    }, context));
    assert.equal(captured.record.project_id, project.id);
    const search = JSON.parse(await hooks.tool.continuitydb_memory_search.execute({ query: marker }, context));
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].project_id, project.id);
    assert.match(search.results[0].body, new RegExp(marker));
  }

  const removed = succeed(binary, [
    "opencode", "uninstall", "--opencode-config-dir", configDir, "--apply",
  ]);
  assert.equal(removed.verified, true);
  assert.equal(succeed(binary, ["projects", "list", "--home", home]).projects.length, 2,
    "uninstall must retain project memory and registry data");
  assert.equal(readFileSync(join(home, "config.json"), "utf8").includes('"default"'), false);

  process.stdout.write(`${JSON.stringify({
    passed: true,
    binary,
    opencode,
    projects: projects.map(({ id, root: projectRoot }) => ({ id, root: projectRoot })),
    checks: [
      "global-install", "real-opencode-plugin-load", "automatic-project-registration",
      "collision-safe-project-ids", "plan-tool-permission", "installed-plugin-handler-capture-search",
      "memory-preserving-uninstall",
    ],
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
