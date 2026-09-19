import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ContextVault } from "../src/store.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function importRepository(repository, home, ...flags) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("CONTINUITYDB_") && !key.startsWith("CONTEXT_VAULT_")));
  const result = spawnSync(process.execPath, [cli, "repo-scan", repository,
    "--home", home, "--project", "batch-fixture", "--ingest", ...flags], {
    encoding: "utf8", env: { ...env, CONTINUITYDB_EMBEDDING_PROVIDER: "none" },
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

function interruptedImport(repository, home, root) {
  const preload = join(root, "interrupt-second-batch.mjs");
  const storeUrl = new URL("../src/store.js", import.meta.url).href;
  writeFileSync(preload, `import { ContextVault } from ${JSON.stringify(storeUrl)};\n`
    + `const original = ContextVault.prototype.ingestBatch; let calls = 0;\n`
    + `ContextVault.prototype.ingestBatch = function (...args) { if (++calls === 2) throw new Error("Synthetic second batch failure"); return original.apply(this, args); };\n`);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("CONTINUITYDB_") && !key.startsWith("CONTEXT_VAULT_")));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href,
    cli, "repo-scan", repository, "--home", home, "--project", "batch-fixture", "--ingest", "--commit"], {
    encoding: "utf8", env: { ...env, CONTINUITYDB_EMBEDDING_PROVIDER: "none" }, timeout: 60_000,
  });
  assert.equal(result.status, 1);
  return result.stderr.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).map(JSON.parse).at(-1);
}

test("CLI ingests and safely retries repositories larger than the store's 1000-record batch", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-large-ingest-"));
  const repository = join(root, "repo");
  const home = join(root, "vault");
  mkdirSync(repository);
  try {
    git(repository, "init");
    for (let index = 0; index < 1001; index += 1) {
      writeFileSync(join(repository, `file-${index}.md`), `Synthetic repository document ${index}.\n`);
    }
    git(repository, "add", ".");
    git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    const interrupted = interruptedImport(repository, home, root);
    assert.equal(interrupted.error, "Synthetic second batch failure");
    assert.equal(interrupted.ingestion.complete, false);
    assert.equal(interrupted.ingestion.total_records, 1001);
    assert.equal(interrupted.ingestion.completed_batches, 1);
    assert.equal(interrupted.ingestion.completed_records, 1000);
    assert.deepEqual(interrupted.ingestion.completed_statuses, { active: 1000 });
    assert.deepEqual(interrupted.ingestion.failed_batch, { offset: 1000, records: 1 });
    const partial = new ContextVault(home);
    let partialIds;
    try { partialIds = partial.db.prepare("SELECT id FROM memory_records ORDER BY id").all().map((row) => row.id); }
    finally { partial.close(); }
    assert.equal(partialIds.length, 1000);
    const first = importRepository(repository, home, "--commit");
    assert.equal(first.produced_records, 1001);
    assert.equal(first.truncated, false);
    assert.equal(first.ingested, 1001);
    assert.equal(first.committed, true);
    assert.deepEqual(first.ingested_statuses, { active: 1001 });
    const vault = new ContextVault(home);
    let ids;
    try {
      ids = vault.db.prepare("SELECT id FROM memory_records ORDER BY id").all();
      assert.equal(ids.length, 1001);
      assert.ok(partialIds.every((id) => ids.some((row) => row.id === id)));
    } finally { vault.close(); }
    const repeated = importRepository(repository, home, "--commit");
    assert.equal(repeated.committed, true);
    assert.deepEqual(repeated.ingested_statuses, { active: 1001 });
    const reopened = new ContextVault(home);
    try {
      assert.deepEqual(reopened.db.prepare("SELECT id FROM memory_records ORDER BY id").all(), ids);
      assert.equal(reopened.verifyAuditLog().valid, true);
      assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM canonical_record_writes").get().n, 0);
    } finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI empty incremental ingestion is a successful no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-empty-ingest-"));
  const repository = join(root, "repo");
  const home = join(root, "vault");
  mkdirSync(repository);
  try {
    git(repository, "init");
    writeFileSync(join(repository, "README.md"), "Synthetic unchanged repository.\n");
    git(repository, "add", ".");
    git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    const result = importRepository(repository, home, "--since", "HEAD", "--commit");
    assert.equal(result.produced_records, 0);
    assert.equal(result.ingested, 0);
    assert.deepEqual(result.ingested_statuses, {});
    const vault = new ContextVault(home);
    try { assert.equal(vault.db.prepare("SELECT count(*) AS n FROM memory_records").get().n, 0); }
    finally { vault.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI explicit commit approves a previously proposed repository scan without changing IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-cli-approve-ingest-"));
  const repository = join(root, "repo");
  const home = join(root, "vault");
  mkdirSync(repository);
  try {
    git(repository, "init");
    writeFileSync(join(repository, "README.md"), "Synthetic proposal approval repository.\n");
    git(repository, "add", ".");
    git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    const proposed = importRepository(repository, home);
    assert.equal(proposed.committed, false);
    assert.deepEqual(proposed.ingested_statuses, { proposed: 1 });
    const before = new ContextVault(home);
    let id;
    try { id = before.db.prepare("SELECT id FROM memory_records").get().id; }
    finally { before.close(); }
    const approved = importRepository(repository, home, "--commit");
    assert.equal(approved.committed, true);
    assert.deepEqual(approved.ingested_statuses, { active: 1 });
    const after = new ContextVault(home);
    try {
      const records = after.db.prepare("SELECT id, status FROM memory_records").all();
      assert.deepEqual(records.map((record) => ({ ...record })), [{ id, status: "active" }]);
    } finally { after.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
