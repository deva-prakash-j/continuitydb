#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const available = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (available.status !== 0) {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: "Codex CLI is not installed" })}\n`);
  process.exit(0);
}
const extension = process.platform === "win32" ? ".exe" : "";
const binary = resolve(process.env.CONTINUITYDB_BINARY_PATH || process.argv[2]
  || join("dist", `continuitydb-${process.platform}-${process.arch}${extension}`));
if (process.platform !== "win32") chmodSync(binary, 0o755);
const root = mkdtempSync(join(tmpdir(), "continuitydb-codex-config-"));
const project = join(root, "project");
const home = join(root, "vault");
const projectId = "codex-generated-probe";
mkdirSync(project);
try {
  const setup = spawnSync(binary, [
    "setup", "--home", home, "--project-dir", project,
    "--project", projectId,
    "--agents", "codex", "--owner", "developer-1", "--apply",
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(setup.status, 0, setup.stderr);
  const result = spawnSync("codex", ["mcp", "get", "continuitydb", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CODEX_HOME: join(project, ".codex") },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.transport.type, "stdio");
  assert.equal(config.transport.command, binary);
  assert.equal(config.transport.env.CONTINUITYDB_ALLOWED_PROJECTS, projectId);
  assert.notEqual(config.transport.env.CONTINUITYDB_ALLOWED_PROJECTS, "default");
  assert.deepEqual(config.enabled_tools.sort(), [
    "handoff_checkpoint", "handoff_latest", "memory_capture", "memory_context_pack", "memory_feedback", "memory_search",
  ].sort());
  process.stdout.write(`${JSON.stringify({
    passed: true,
    client: available.stdout.trim(),
    verified: ["generated project config", "stdio command", "tool allowlist"],
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
