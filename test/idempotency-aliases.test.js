import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapturePolicy } from "../src/capture-policy.js";
import { normalizeIdentity } from "../src/security.js";
import { ContextVault } from "../src/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-idempotency-aliases-"));
  return { root, home: join(root, "vault"), vault: new ContextVault(join(root, "vault")) };
}

const identity = normalizeIdentity({ tenant_id: "local", owner_id: "local-user", principal_id: "fixture", agent_id: "fixture", scopes: ["memory:capture"], allowed_projects: ["api"], allowed_sensitivities: ["private"] });
const observation = { project_id: "api", memory_kind: "working", body: "Synthetic repeatable observation" };
const policy = new CapturePolicy();
const remember = (vault, key) => vault.capture(policy.evaluate({ ...observation, idempotency_key: key }, identity, vault));

function expire(vault, id) {
  vault.runTransaction(() => {
    const record = { ...vault.get(id, { includeInactive: true }), expires_at: new Date(Date.now() - 1000).toISOString() };
    vault.indexRecord(record);
    vault.writeCanonical(record);
  });
}

test("content-deduplicated capture request stays idempotent after expiry and reopen while a new observation refreshes", () => {
  const f = fixture();
  let reopened;
  let closed = false;
  try {
    const first = remember(f.vault, "observation-a");
    const second = remember(f.vault, "observation-b");
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, first.record.id);
    assert.deepEqual({ ...second.record }, { ...first.record });
    assert.equal(Object.hasOwn(second.record, "idempotency_aliases"), false);
    expire(f.vault, first.record.id);
    f.vault.close(); closed = true;
    reopened = new ContextVault(f.home);
    const retry = remember(reopened, "observation-b");
    assert.equal(retry.record.id, first.record.id);
    assert.equal(retry.duplicate, true);
    assert.ok(Date.parse(retry.record.expires_at) < Date.now());
    const fresh = remember(reopened, "observation-c");
    assert.notEqual(fresh.record.id, first.record.id);
    assert.equal(fresh.disposition, "active");
    assert.ok(Date.parse(fresh.record.expires_at) > Date.now());
  } finally { if (!closed) f.vault.close(); reopened?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("canonical rebuild and JSONL restoration preserve alias retries without exposing aliases on ordinary records", () => {
  const f = fixture();
  const restored = new ContextVault(join(f.root, "restored"));
  let reader;
  try {
    const first = remember(f.vault, "observation-a");
    remember(f.vault, "observation-b");
    expire(f.vault, first.record.id);
    const canonicalBefore = readFileSync(f.vault.recordPath(first.record.id), "utf8");
    f.vault.rebuildIndex();
    assert.equal(readFileSync(f.vault.recordPath(first.record.id), "utf8"), canonicalBefore);
    assert.equal(remember(f.vault, "observation-b").record.id, first.record.id);
    const exported = f.vault.exportJsonl();
    const records = exported.split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].idempotency_aliases.length, 1);
    reader = new ContextVault(f.home, { readOnly: true });
    assert.deepEqual(JSON.parse(reader.exportJsonl()).idempotency_aliases, records[0].idempotency_aliases);
    reader.close(); reader = null;
    restored.runTransaction(() => {
      for (const record of records) { restored.indexRecord(record); restored.writeCanonical(record); }
    });
    restored.rebuildIndex();
    assert.equal(remember(restored, "observation-b").record.id, first.record.id);
    assert.equal(Object.hasOwn(restored.get(first.record.id, { includeInactive: true }), "idempotency_aliases"), false);
    assert.equal(restored.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    restored.forget(first.record.id);
    const removedRetry = remember(restored, "observation-b");
    assert.equal(removedRetry.record.id, first.record.id);
    assert.equal(removedRetry.disposition, "tombstoned");
    assert.equal(JSON.parse(restored.exportJsonl()).idempotency_aliases.length, 1);
    assert.equal(f.vault.verifyAuditLog().valid, true);
  } finally { reader?.close(); restored.close(); f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("aliases retain caller-agent scope and ordinary capture input cannot supply internal alias state", () => {
  const f = fixture();
  try {
    const base = { tenant_id: "tenant-a", owner_id: "owner-a", namespace_id: "project/api", project_id: "api", agent_id: "agent-a", body: "Synthetic alias scope", idempotency_key: "first" };
    const first = f.vault.ingestBatch([base], { commit: true })[0];
    const duplicate = f.vault.propose({ ...base, agent_id: "agent-b", idempotency_key: "second" });
    assert.equal(duplicate.record.id, first.id);
    expire(f.vault, first.id);
    const key = { tenant_id: base.tenant_id, owner_id: base.owner_id, namespace_id: base.namespace_id, agent_id: "agent-b", idempotency_key: "second" };
    assert.equal(f.vault.findByIdempotency(key).id, first.id);
    for (const changed of [{ tenant_id: "tenant-b" }, { owner_id: "owner-b" }, { namespace_id: "project/other" }, { agent_id: "agent-a" }]) {
      assert.equal(f.vault.findByIdempotency({ ...key, ...changed }), null);
    }
    f.vault.propose({ ...base, body: "Synthetic ordinary proposal", idempotency_key: "ordinary", idempotency_aliases: [{ agent_id: "agent-b", idempotency_key: "untrusted-input-alias" }] });
    assert.equal(f.vault.findByIdempotency({ ...key, idempotency_key: "untrusted-input-alias" }), null);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("alias acknowledgment survives canonical EIO and a failed outer operation rolls it back", () => {
  const f = fixture();
  try {
    const first = remember(f.vault, "observation-a");
    const original = f.vault.writeCanonicalFile.bind(f.vault);
    f.vault.writeCanonicalFile = () => { throw Object.assign(new Error("synthetic alias projection failure"), { code: "EIO" }); };
    assert.throws(() => remember(f.vault, "observation-b"), (error) => error.code === "CANONICAL_PROJECTION_PENDING" && error.committed === true);
    f.vault.writeCanonicalFile = original;
    f.vault.flushCanonicalWrites();
    assert.equal(remember(f.vault, "observation-b").record.id, first.record.id);
    assert.throws(() => f.vault.runTransaction(() => { remember(f.vault, "observation-c"); throw new Error("synthetic rollback"); }), /synthetic rollback/);
    expire(f.vault, first.record.id);
    assert.equal(remember(f.vault, "observation-b").record.id, first.record.id);
    assert.notEqual(remember(f.vault, "observation-c").record.id, first.record.id);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy canonical records remain byte-identical through rebuild and alias import conflicts roll back", () => {
  const f = fixture();
  try {
    const first = remember(f.vault, "observation-a");
    const original = readFileSync(f.vault.recordPath(first.record.id), "utf8");
    assert.equal(Object.hasOwn(JSON.parse(f.vault.exportJsonl()), "idempotency_aliases"), false);
    f.vault.rebuildIndex();
    assert.equal(readFileSync(f.vault.recordPath(first.record.id), "utf8"), original);
    const other = f.vault.propose({ body: "Synthetic distinct import", namespace_id: "project/api", agent_id: "fixture", idempotency_key: "taken" }).record;
    assert.throws(() => f.vault.indexRecord({ ...other, idempotency_aliases: [{ agent_id: "fixture", idempotency_key: first.record.idempotency_key }] }), /idempotency.*conflict/);
    assert.throws(() => f.vault.indexRecord({ ...other, idempotency_aliases: [{ agent_id: "fixture", idempotency_key: "valid", tenant_id: "different" }] }), /alias.*field/);
    f.vault.propose({ body: other.body, namespace_id: "project/api", agent_id: "fixture", idempotency_key: "alias-taken" });
    assert.throws(() => f.vault.indexRecord({ ...first.record, idempotency_key: "alias-taken" }), /idempotency.*conflict/);
    f.vault.indexRecord({ ...other, idempotency_aliases: [{ agent_id: "fixture", idempotency_key: " trimmed-import " }] });
    assert.equal(f.vault.findByIdempotency({ ...other, idempotency_key: "trimmed-import" }).id, other.id);
    assert.equal(f.vault.get(other.id, { includeInactive: true }).id, other.id);
    assert.equal(readFileSync(f.vault.recordPath(first.record.id), "utf8"), original);
    assert.equal(f.vault.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("read-only export keeps memory rows and aliases in one snapshot while a writer acknowledges a duplicate", () => {
  const f = fixture();
  let reader;
  try {
    const first = remember(f.vault, "observation-a");
    reader = new ContextVault(f.home, { readOnly: true });
    const original = reader.recordWithIdempotencyAliases.bind(reader);
    let writeDuringExport = true;
    reader.recordWithIdempotencyAliases = (record) => {
      if (writeDuringExport) { writeDuringExport = false; remember(f.vault, "observation-b"); }
      return original(record);
    };
    const snapshot = JSON.parse(reader.exportJsonl());
    assert.equal(snapshot.id, first.record.id);
    assert.equal(Object.hasOwn(snapshot, "idempotency_aliases"), false);
    const after = JSON.parse(reader.exportJsonl());
    assert.equal(after.idempotency_aliases.length, 1);
  } finally { reader?.close(); f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("read-only opening a pre-alias index supports export and primary retries without migrating", () => {
  const f = fixture();
  let reader;
  try {
    const first = remember(f.vault, "observation-a");
    f.vault.db.exec("DROP TABLE memory_idempotency_aliases");
    const schemaBefore = f.vault.db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all();
    reader = new ContextVault(f.home, { readOnly: true });
    assert.equal(reader.get(first.record.id).id, first.record.id);
    assert.equal(reader.findByIdempotency(first.record).id, first.record.id);
    assert.equal(JSON.parse(reader.exportJsonl()).id, first.record.id);
    assert.deepEqual(f.vault.db.prepare("SELECT sql FROM sqlite_schema ORDER BY name").all(), schemaBefore);
    assert.equal(f.vault.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'memory_idempotency_aliases'").get(), undefined);
  } finally { reader?.close(); f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});
