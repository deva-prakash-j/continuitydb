import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { connectAgent, migrateManagedOpenCodeProjects } from "../src/agent-connectors.js";
import { registerProject } from "../src/project-registry.js";
import { ensureTrustedProject } from "../src/trusted-project.js";
import {
  canonicalOpenCodeConfigDir,
  globalOpenCodeStatus,
  installGlobalOpenCode,
  uninstallGlobalOpenCode,
} from "../src/opencode-global-install.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("global OpenCode config canonicalizes only the trusted macOS /var alias", () => {
  assert.equal(canonicalOpenCodeConfigDir("/var/folders/example/opencode", "darwin"),
    "/private/var/folders/example/opencode");
  assert.equal(canonicalOpenCodeConfigDir("/var", "darwin"), "/private/var");
  assert.equal(canonicalOpenCodeConfigDir("/var/folders/example/opencode", "linux"),
    "/var/folders/example/opencode");
  assert.equal(canonicalOpenCodeConfigDir("/variable/opencode", "darwin"),
    "/variable/opencode");
});

function repository(parent, name) {
  const repo = join(parent, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

function run(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: {
    ...process.env,
    CONTINUITYDB_EMBEDDING_PROVIDER: "",
    CONTINUITYDB_MODEL_URL: "",
  } });
}

function optionalText(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

test("global OpenCode install previews, applies idempotently, reports status, and uninstalls", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-install-"));
  const one = join(root, "one");
  const two = join(root, "two");
  const configDir = join(root, "opencode");
  const home = join(root, "vault");
  mkdirSync(one); mkdirSync(two);
  try {
    const options = { home, workspaceRoots: [one, two], configDir, binary: process.execPath };
    const preview = installGlobalOpenCode(options);
    assert.equal(preview.applied, false);
    assert.equal(preview.changed, true);
    assert.equal(preview.verified, false);
    assert.equal(globalOpenCodeStatus({ configDir }).installed, false);

    const applied = installGlobalOpenCode({ ...options, apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.verified, true);
    assert.equal(installGlobalOpenCode({ ...options, apply: true }).changed, false);
    const status = globalOpenCodeStatus({ configDir });
    assert.equal(status.installed, true);
    assert.equal(status.verified, true);
    assert.deepEqual(status.workspace_roots, [one, two]);
    assert.match(readFileSync(status.plugin, "utf8"), /ContinuityDBGlobalPlugin/);

    const removed = uninstallGlobalOpenCode({ configDir, apply: true });
    assert.equal(removed.applied, true);
    assert.equal(globalOpenCodeStatus({ configDir }).installed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global OpenCode install refuses unmanaged, drifted, and symlinked targets", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-install-deny-"));
  const workspace = join(root, "workspace");
  const configDir = join(root, "opencode");
  const plugins = join(configDir, "plugins");
  mkdirSync(workspace); mkdirSync(plugins, { recursive: true });
  const plugin = join(plugins, "continuitydb.js");
  try {
    writeFileSync(plugin, "// user plugin\n");
    assert.throws(() => installGlobalOpenCode({
      home: join(root, "vault"), workspaceRoots: [workspace], configDir, binary: process.execPath, apply: true,
    }), /unmanaged global OpenCode plugin/i);
    rmSync(plugin);
    rmSync(plugins, { recursive: true });
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, plugins);
    assert.throws(() => installGlobalOpenCode({
      home: join(root, "vault"), workspaceRoots: [workspace], configDir, binary: process.execPath, apply: true,
    }), /symbolic link|real directory/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global OpenCode uninstall refuses a substituted plugin parent and preserves outside bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-uninstall-parent-"));
  const workspace = join(root, "workspace");
  const configDir = join(root, "opencode");
  const plugins = join(configDir, "plugins");
  const plugin = join(plugins, "continuitydb.js");
  const outside = join(root, "outside");
  const outsidePlugin = join(outside, "continuitydb.js");
  mkdirSync(workspace);
  try {
    installGlobalOpenCode({
      home: join(root, "vault"), workspaceRoots: [workspace], configDir,
      binary: process.execPath, apply: true,
    });
    const managed = readFileSync(plugin, "utf8");
    mkdirSync(outside);
    writeFileSync(outsidePlugin, managed);
    rmSync(plugins, { recursive: true });
    symlinkSync(outside, plugins, process.platform === "win32" ? "junction" : "dir");

    assert.throws(
      () => uninstallGlobalOpenCode({ configDir, apply: true }),
      /parent|ancestor|symbolic link|directory/i,
    );
    assert.equal(readFileSync(outsidePlugin, "utf8"), managed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI installs once and automatically ensures arbitrary trusted repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-cli-"));
  const workspaceOne = join(root, "workspace-one");
  const workspaceTwo = join(root, "workspace-two");
  const repoOne = repository(workspaceOne, "service");
  const repoTwo = repository(workspaceTwo, "service");
  const home = join(root, "vault");
  const configDir = join(root, "opencode");
  try {
    const installed = run([
      "opencode", "install", "--workspace-root", workspaceOne, "--workspace-root", workspaceTwo,
      "--opencode-config-dir", configDir, "--home", home, "--apply",
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).verified, true);

    for (const repo of [repoOne, repoTwo]) {
      const ensured = run([
        "opencode", "ensure", "--project-dir", repo,
        "--workspace-root", workspaceOne, "--workspace-root", workspaceTwo,
        "--home", home, "--apply",
      ]);
      assert.equal(ensured.status, 0, ensured.stderr);
      assert.equal(JSON.parse(ensured.stdout).project.root, repo);
    }
    const listed = run(["projects", "list", "--home", home]);
    assert.equal(listed.status, 0, listed.stderr);
    const projects = JSON.parse(listed.stdout).projects;
    assert.equal(projects.length, 2);
    assert.equal(projects[0].id, "service");
    assert.match(projects[1].id, /^service-[a-f0-9]{12}$/);

    const status = run(["opencode", "status", "--opencode-config-dir", configDir]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).verified, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one global install migrates owned project-local OpenCode adapters under trusted roots", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-migrate-"));
  const workspace = join(root, "workspace");
  const repo = repository(workspace, "legacy-service");
  const home = join(root, "vault");
  const configDir = join(root, "opencode-global");
  try {
    registerProject(home, { id: "default", root: repo, source: "explicit" }, { apply: true });
    connectAgent("opencode", {
      projectDir: repo, projectId: "default", home, apply: true,
      transport: "stdio", projects: ["default"], sensitivities: ["public", "private"],
      tenantId: "local", ownerId: "local-user", binary: process.execPath,
    });
    assert.match(readFileSync(join(repo, "opencode.json"), "utf8"), /continuitydb/);
    assert.match(readFileSync(join(repo, ".opencode", "plugins", "continuitydb.js"), "utf8"), /managed opencode ownership/);

    const result = installGlobalOpenCode({
      home, workspaceRoots: [workspace], configDir, binary: process.execPath, apply: true,
    });
    assert.equal(result.verified, true);
    assert.deepEqual(result.migrated_projects, [repo]);
    assert.equal(optionalText(join(repo, "opencode.json"))?.includes("continuitydb") || false, false);
    assert.equal(optionalText(join(repo, "AGENTS.md"))?.includes("continuitydb managed policy") || false, false);
    assert.equal(optionalText(join(repo, ".opencode", "plugins", "continuitydb.js")), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one global install supports forty-nine repositories without widening project scope", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-many-"));
  const workspace = join(root, "workspace");
  const home = join(root, "vault");
  const configDir = join(root, "opencode");
  try {
    const repos = Array.from({ length: 49 }, (_, index) => repository(workspace, `repo-${index + 1}`));
    assert.equal(installGlobalOpenCode({
      home, workspaceRoots: [workspace], configDir, binary: process.execPath, apply: true,
    }).verified, true);
    for (const repo of repos) {
      ensureTrustedProject(home, { directory: repo, workspaceRoots: [workspace], apply: true });
    }
    const projects = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).projects;
    assert.equal(projects.length, 49);
    assert.equal(new Set(projects.map((project) => project.id)).size, 49);
    assert.equal(projects.some((project) => project.id === "default"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy migration restores every project-local asset when finalization fails", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-migrate-rollback-"));
  const workspace = join(root, "workspace");
  const repo = repository(workspace, "legacy-service");
  const home = join(root, "vault");
  try {
    registerProject(home, { id: "legacy-service", root: repo, source: "git" }, { apply: true });
    connectAgent("opencode", {
      projectDir: repo, projectId: "legacy-service", home, apply: true,
      transport: "stdio", projects: ["legacy-service"], sensitivities: ["public", "private"],
      tenantId: "local", ownerId: "local-user", binary: process.execPath,
    });
    const paths = [
      join(repo, "opencode.json"), join(repo, "AGENTS.md"),
      join(repo, ".opencode", "plugins", "continuitydb.js"),
    ];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    assert.throws(() => migrateManagedOpenCodeProjects([
      { projectDir: repo, projectId: "legacy-service" },
    ], {
      home, apply: true, transport: "stdio", tenantId: "local", ownerId: "local-user",
      sensitivities: ["public", "private"], _finalize: () => { throw new Error("injected global install failure"); },
    }), /injected global install failure/);
    assert.deepEqual(paths.map((path) => readFileSync(path, "utf8")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global install bounds legacy scanning and refuses unmanaged project plugins", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-scan-"));
  const workspace = join(root, "workspace");
  const repo = repository(workspace, "service");
  const configDir = join(root, "opencode");
  mkdirSync(join(repo, ".opencode", "plugins"), { recursive: true });
  writeFileSync(join(repo, ".opencode", "plugins", "continuitydb.js"), "// user-owned plugin\n");
  try {
    assert.throws(() => installGlobalOpenCode({
      home: join(root, "vault"), workspaceRoots: [workspace], configDir,
      binary: process.execPath, apply: true,
    }), /unmanaged OpenCode plugin/i);
    assert.equal(globalOpenCodeStatus({ configDir }).installed, false);
    assert.throws(() => installGlobalOpenCode({
      home: join(root, "vault"), workspaceRoots: [workspace], configDir,
      binary: process.execPath, scanBudget: 1,
    }), /exceeded directory budget/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
