import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapturePolicy, loadCapturePolicy } from "../src/capture-policy.js";
import { CanonicalProjectionError, ContextVault } from "../src/store.js";

const storeModule = new URL("../src/store.js", import.meta.url).href;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-store-stability-"));
  const home = join(root, "vault");
  return { root, home, vault: new ContextVault(home) };
}

function canonical(vault, id) {
  return JSON.parse(readFileSync(vault.recordPath(id), "utf8").split("\n")[1]);
}

function pending(vault) {
  return Number(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count);
}

function child(script, root, args = []) {
  const processHome = join(root, "child-home");
  const processTemp = join(root, "child-tmp");
  mkdirSync(processHome, { recursive: true });
  mkdirSync(processTemp, { recursive: true });
  const worker = spawn(process.execPath, ["--input-type=module", "--eval", script, ...args], {
    cwd: root,
    env: { ...process.env, HOME: processHome, TMPDIR: processTemp, CONTINUITYDB_HOME: join(root, "unused"), CONTEXT_VAULT_HOME: join(root, "unused") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const listeners = new Set();
  worker.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const check of listeners) check();
  });
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
      for (const check of listeners) check(true);
    });
  });
  const line = (value) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(check);
      worker.kill("SIGKILL");
      reject(new Error(`worker did not print ${value}: ${stdout}\n${stderr}`));
    }, 15_000);
    const check = (closed = false) => {
      if (stdout.split(/\r?\n/).includes(value)) {
        clearTimeout(timer); listeners.delete(check); resolve();
      } else if (closed) {
        clearTimeout(timer); listeners.delete(check); reject(new Error(`worker exited before ${value}: ${stdout}\n${stderr}`));
      }
    };
    listeners.add(check);
    check();
  });
  return { worker, exited, line };
}

const crashScript = `
  import { ContextVault } from ${JSON.stringify(storeModule)};
  const [home, phase] = process.argv.slice(1);
  const vault = new ContextVault(home);
  const pause = () => {
    process.stdout.write("paused\\n");
    while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  };
  if (phase === "before-commit") {
    const original = vault.writeCanonical.bind(vault);
    vault.writeCanonical = (record) => { original(record); pause(); };
  } else if (phase === "after-commit") {
    vault.flushCanonicalWrites = pause;
  } else {
    const original = vault.writeCanonicalFile.bind(vault);
    vault.writeCanonicalFile = (...args) => { original(...args); pause(); };
  }
  vault.capture({ disposition: "active", reason: "synthetic policy", record: {
    body: "Synthetic crash recovery checkpoint", idempotency_key: "crash-checkpoint"
  }});
`;

for (const phase of ["before-commit", "after-commit", "after-rename"]) {
  test(`canonical outbox recovers a terminated process ${phase}`, async () => {
    const f = fixture();
    f.vault.close();
    let running;
    let recovered;
    try {
      running = child(crashScript, f.root, [f.home, phase]);
      await running.line("paused");
      running.worker.kill("SIGKILL");
      const result = await running.exited;
      assert.equal(result.signal, "SIGKILL");
      recovered = new ContextVault(f.home);
      const records = recovered.db.prepare("SELECT * FROM memory_records").all();
      assert.equal(records.length, phase === "before-commit" ? 0 : 1);
      assert.equal(pending(recovered), 0);
      if (records.length) {
        assert.equal(records[0].status, "active");
        assert.equal(canonical(recovered, records[0].id).status, "active");
        assert.equal(recovered.search({ query: "checkpoint" }).length, 1);
      } else assert.equal(recovered.exportJsonl(), "");
      assert.equal(recovered.verifyAuditLog().valid, true);
    } finally {
      if (running?.worker.exitCode === null && running.worker.signalCode === null) {
        running.worker.kill("SIGKILL"); await running.exited;
      }
      recovered?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("rejected handoff transaction cannot publish a canonical successor", () => {
  const f = fixture();
  try {
    const assessment = { disposition: "active", reason: "synthetic policy", expires_at: new Date(Date.now() + 3600_000).toISOString(), activation_ttl_seconds: 3600, quota_limit: 100 };
    const input = { project_id: "demo", task_id: "task", agent_id: "agent", goal: "Synthetic task", current_state: "First checkpoint", checkpoint_id: "first" };
    const first = f.vault.saveHandoff(input, { assessment });
    const original = f.vault.writeCanonical.bind(f.vault);
    f.vault.writeCanonical = (record) => {
      if (record.status === "superseded") throw new Error("synthetic transaction failure");
      original(record);
    };
    assert.throws(() => f.vault.saveHandoff({ ...input, current_state: "Second checkpoint", checkpoint_id: "second", previous_checkpoint_id: "first" }, { assessment }), /synthetic transaction failure/);
    f.vault.writeCanonical = original;
    assert.equal(pending(f.vault), 0);
    assert.equal(f.vault.rebuildIndex().records, 1);
    assert.equal(f.vault.latestHandoff({ project_id: "demo", task_id: "task" }).record.id, first.record.id);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("nested export, rebuild and flush cannot publish an uncommitted memory", () => {
  const f = fixture();
  try {
    assert.throws(() => f.vault.runTransaction(() => {
      f.vault.propose({ body: "Synthetic rolled back outer transaction" });
      assert.throws(() => f.vault.exportJsonl(), /cannot export inside/);
      assert.throws(() => f.vault.rebuildIndex(), /cannot rebuild inside/);
      assert.throws(() => f.vault.flushCanonicalWrites(), /cannot flush canonical writes inside/);
      assert.throws(() => f.vault.flushCanonicalWritesUnsafe(), /before their transaction commits/);
      throw new Error("synthetic outer rollback");
    }), /synthetic outer rollback/);
    assert.equal(f.vault.exportJsonl(), "");
    assert.equal(pending(f.vault), 0);
    assert.deepEqual(f.vault.stats().records, {});
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("post-commit I/O failure reports committed state and a newer tombstone supersedes pending projection", () => {
  const f = fixture();
  try {
    const original = f.vault.writeCanonicalFile.bind(f.vault);
    f.vault.writeCanonicalFile = () => { const error = new Error("synthetic I/O failure"); error.code = "EIO"; throw error; };
    assert.throws(() => f.vault.capture({ disposition: "active", reason: "synthetic policy", record: { body: "Synthetic durable memory", idempotency_key: "pending-memory" } }), (error) => {
      assert.ok(error instanceof CanonicalProjectionError);
      assert.equal(error.code, "CANONICAL_PROJECTION_PENDING");
      assert.equal(error.committed, true);
      assert.equal(error.recovery_pending, true);
      assert.equal(error.cause.code, "EIO");
      return true;
    });
    const record = f.vault.db.prepare("SELECT * FROM memory_records").get();
    assert.equal(record.status, "active");
    assert.equal(existsSync(f.vault.recordPath(record.id)), false);
    assert.equal(pending(f.vault), 1);
    f.vault.writeCanonicalFile = original;
    f.vault.forget(record.id);
    assert.equal(canonical(f.vault, record.id).status, "tombstoned");
    assert.equal(pending(f.vault), 0);
    f.vault.rebuildIndex();
    assert.equal(f.vault.search({ query: "durable" }).length, 0);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const operation of ["exportJsonl", "rebuildIndex"]) {
  test(`${operation} recovers pending committed projections before reading canonical files`, () => {
    const f = fixture();
    try {
      const original = f.vault.writeCanonicalFile.bind(f.vault);
      f.vault.writeCanonicalFile = () => { throw new Error("synthetic filesystem unavailable"); };
      assert.throws(() => f.vault.capture({ disposition: "active", reason: "synthetic policy", record: { body: "Synthetic pending canonical snapshot" } }), CanonicalProjectionError);
      const record = f.vault.db.prepare("SELECT * FROM memory_records").get();
      assert.equal(pending(f.vault), 1);
      const reader = new ContextVault(f.home, { readOnly: true });
      try { assert.equal(JSON.parse(reader.exportJsonl()).id, record.id); }
      finally { reader.close(); }
      assert.equal(pending(f.vault), 1, "read-only export must not drain pending writes");
      f.vault.writeCanonicalFile = original;
      const result = f.vault[operation]();
      if (operation === "exportJsonl") assert.equal(JSON.parse(result).id, record.id);
      else assert.deepEqual(result, { records: 1 });
      assert.equal(canonical(f.vault, record.id).status, "active");
      assert.equal(pending(f.vault), 0);
    } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("concurrent idempotent capture returns one surviving record ID", async () => {
  const f = fixture();
  f.vault.close();
  const script = `
    import { ContextVault } from ${JSON.stringify(storeModule)};
    const vault = new ContextVault(process.argv[1]);
    process.stdout.write("ready\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    const result = vault.capture({ disposition: "active", reason: "synthetic policy", record: {
      body: "Synthetic concurrent retry", idempotency_key: "one-request"
    }});
    process.stdout.write(JSON.stringify({id: result.record.id, duplicate: result.duplicate}) + "\\n");
    vault.close(); process.stdin.destroy();
  `;
  const workers = [child(script, f.root, [f.home]), child(script, f.root, [f.home])];
  let recovered;
  try {
    await Promise.all(workers.map((worker) => worker.line("ready")));
    for (const { worker } of workers) worker.stdin.end("go\n");
    const results = await Promise.all(workers.map((worker) => worker.exited));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const records = results.map((result) => JSON.parse(result.stdout.trim().split("\n").at(-1)));
    assert.equal(records[0].id, records[1].id);
    assert.deepEqual(records.map((record) => record.duplicate).sort(), [false, true]);
    recovered = new ContextVault(f.home);
    assert.equal(recovered.get(records[0].id).status, "active");
    assert.equal(recovered.rebuildIndex().records, 1);
    assert.equal(recovered.verifyAuditLog().valid, true);
  } finally {
    for (const running of workers) if (running.worker.exitCode === null && running.worker.signalCode === null) { running.worker.kill("SIGKILL"); await running.exited; }
    recovered?.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("rebuild preserves feedback, links and unchanged embeddings and refuses missing canonical records", () => {
  const f = fixture();
  try {
    const first = f.vault.commit(f.vault.propose({ body: "Synthetic rebuild source" }).record.id);
    const second = f.vault.commit(f.vault.propose({ body: "Synthetic rebuild destination" }).record.id);
    f.vault.linkMemories({ source_memory_id: first.id, target_memory_id: second.id, relation: "related", provenance: "Synthetic relation" });
    f.vault.feedback({ tenant_id: "local", owner_id: "local-user", principal_id: "reviewer", memory_id: first.id, signal: "helpful" });
    f.vault.putEmbedding(first.id, [1, 0, 0, 0, 0, 0, 0, 0], "synthetic-model");
    assert.deepEqual(f.vault.rebuildIndex(), { records: 2 });
    assert.equal(f.vault.stats().feedback, 1);
    assert.equal(f.vault.stats().memory_edges, 1);
    assert.equal(f.vault.db.prepare("SELECT count(*) AS count FROM memory_embeddings").get().count, 1);
    assert.equal(f.vault.search({ query: "source" })[0].feedback.helpful, 1);
    unlinkSync(f.vault.recordPath(second.id));
    assert.throws(() => f.vault.rebuildIndex(), /missing; refusing a destructive rebuild/);
    assert.equal(f.vault.stats().records.active, 2);
    assert.equal(f.vault.stats().feedback, 1);
    assert.equal(f.vault.stats().memory_edges, 1);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("fresh equivalent captures do not deduplicate against temporally inapplicable memories", () => {
  const f = fixture();
  const policy = new CapturePolicy(loadCapturePolicy(null));
  const identity = { tenant_id: "local", owner_id: "local-user", principal_id: "agent", agent_id: "agent", allowed_projects: ["demo"], allowed_sensitivities: ["private"] };
  try {
    for (const [name, temporal] of Object.entries({ expired: { expires_at: "2020-01-01T00:00:00Z" }, ended: { valid_to: "2020-01-01T00:00:00Z" }, future: { valid_from: "2100-01-01T00:00:00Z" }, stale: { stale: true } })) {
      const body = `Synthetic ${name} capture`;
      const old = f.vault.commit(f.vault.propose({ body, type: "working", project_id: "demo", namespace_id: "project/demo", ...temporal }).record.id);
      const fresh = f.vault.capture(policy.evaluate({ body, memory_kind: "working", project_id: "demo" }, identity, f.vault));
      assert.equal(fresh.duplicate, false, name);
      assert.notEqual(fresh.record.id, old.id, name);
      const recalled = f.vault.search({ query: name, project_id: "demo", allowed_projects: ["demo"] });
      assert.ok(recalled.some((record) => record.id === fresh.record.id), name);
      assert.ok(!recalled.some((record) => record.id === old.id), name);
    }
    const body = "Synthetic previously superseded capture";
    const old = f.vault.commit(f.vault.propose({ body, type: "working", project_id: "demo", namespace_id: "project/demo" }).record.id);
    f.vault.correct(old.id, { body: "Synthetic replacement observation" }, "Synthetic correction");
    const fresh = f.vault.capture(policy.evaluate({ body, memory_kind: "working", project_id: "demo" }, identity, f.vault));
    assert.equal(fresh.duplicate, false);
    assert.notEqual(fresh.record.id, old.id);
  } finally { f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("read-only vault observes uncheckpointed schema and committed WAL updates", () => {
  const f = fixture();
  let reader;
  try {
    const first = f.vault.commit(f.vault.propose({ body: "Synthetic WAL reader source" }).record.id);
    assert.ok(existsSync(join(f.home, "index", "context-vault.db-wal")));
    reader = new ContextVault(f.home, { readOnly: true });
    assert.equal(reader.get(first.id).body, first.body);
    const next = f.vault.commit(f.vault.propose({ body: "Synthetic WAL next commit" }).record.id);
    assert.equal(reader.get(next.id).body, next.body);
    assert.equal(reader.stats().records.active, 2);
    assert.equal(reader.verifyAuditLog().valid, true);
    assert.deepEqual(reader.exportJsonl().split("\n").map((line) => JSON.parse(line).id).sort(), [first.id, next.id].sort());
  } finally { reader?.close(); f.vault.close(); rmSync(f.root, { recursive: true, force: true }); }
});
