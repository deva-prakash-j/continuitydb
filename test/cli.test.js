import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
