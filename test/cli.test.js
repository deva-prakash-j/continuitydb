import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_LOCAL_MODEL } from "../src/local-embeddings.js";
import { ContextVault } from "../src/store.js";

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
