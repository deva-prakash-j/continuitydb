import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliUrl = new URL("../src/cli.js", import.meta.url).href;
const storeUrl = new URL("../src/store.js", import.meta.url).href;

test("CLI preserves committed recovery metadata without exposing underlying I/O details", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-recovery-error-"));
  try {
    for (const committed of [true, false]) {
      // Node 22 may emit SQLite experimental warnings alongside application JSON.
      const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `
        import { ContextVault } from ${JSON.stringify(storeUrl)};
        ContextVault.prototype.stats = () => {
          const error = new Error("fixture I/O detail");
          Object.assign(error, { name: "CanonicalProjectionError", code: "CANONICAL_PROJECTION_PENDING", committed: ${committed}, recovery_pending: true });
          throw error;
        };
        process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cliUrl))}, "stats", "--home", ${JSON.stringify(join(root, String(committed)))}];
        await import(${JSON.stringify(cliUrl)});
      `], {
        encoding: "utf8", timeout: 15000,
        env: { ...process.env, CONTINUITYDB_EMBEDDING_PROVIDER: "", CONTINUITYDB_MODEL_URL: "" },
      });
      assert.equal(result.status, 1, result.stderr);
      const error = JSON.parse(result.stderr.trim());
      assert.equal(error.command, "stats");
      if (committed) {
        assert.equal(error.code, "CANONICAL_PROJECTION_PENDING");
        assert.equal(error.committed, true);
        assert.equal(error.recovery_pending, true);
        assert.match(error.error, /committed.*recovery/);
        assert.doesNotMatch(result.stderr, /fixture I\/O detail|stack|cause/);
      } else {
        assert.deepEqual(error, { error: "fixture I/O detail", command: "stats" });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
