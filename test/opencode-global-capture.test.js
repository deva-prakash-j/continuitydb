import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ContextVault } from "../src/store.js";
import { renderGlobalOpenCodePlugin } from "../src/opencode-global-plugin-template.js";

// Every invocation uses the generated tool, real CLI and an isolated vault.
// The wrapper only records invocation identity and optionally injects one EIO.
async function fixture({ policy = {}, runtimePolicy = false, pending = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-global-capture-"));
  const repo = join(root, "service");
  const home = join(root, "vault");
  const policyPath = join(root, "capture-policy.json");
  const executable = join(root, "continuitydb-fixture.mjs");
  const callsPath = join(root, "calls.jsonl");
  const pendingMarker = join(root, "inject-once");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  if (pending) writeFileSync(pendingMarker, "synthetic fixture only");
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { ContextVault } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  policy: process.env.CONTINUITYDB_CAPTURE_POLICY_FILE,
  tenant: process.env.CONTINUITYDB_TENANT_ID,
  owner: process.env.CONTINUITYDB_OWNER_ID,
  sensitivities: process.env.CONTINUITYDB_ALLOWED_SENSITIVITIES,
  projects: process.env.CONTINUITYDB_ALLOWED_PROJECTS,
  inheritedUnrelated: Object.hasOwn(process.env, "CONTINUITYDB_UNRELATED_FIXTURE"),
}) + "\\n");
if (process.argv[2] === "capture" && existsSync(${JSON.stringify(pendingMarker)})) {
  rmSync(${JSON.stringify(pendingMarker)});
  ContextVault.prototype.writeCanonicalFile = () => {
    throw Object.assign(new Error("synthetic private projection detail"), { code: "EIO" });
  };
}
await import(${JSON.stringify(new URL("../src/cli.js", import.meta.url).href)});
`, { mode: 0o755 });
  chmodSync(executable, 0o755);
  const source = renderGlobalOpenCodePlugin({
    executable, home, workspaceRoots: [root],
    tenantId: "fixture-team", ownerId: "fixture-owner", sensitivities: ["private"],
    capturePolicyFile: runtimePolicy ? null : policyPath,
  }).replace('from "@opencode-ai/plugin";', `from ${JSON.stringify(import.meta.resolve("@opencode-ai/plugin"))};`);
  const pluginPath = join(root, "plugin.mjs");
  writeFileSync(pluginPath, source, { mode: 0o600 });
  let hooks;
  try {
    const module = await import(pathToFileURL(pluginPath).href);
    const logs = [];
    hooks = await module.ContinuityDBGlobalPlugin({
      directory: repo, client: { app: { log: async ({ body }) => logs.push(body) } },
    });
    assert.deepEqual(logs, []);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const context = { directory: repo, worktree: repo, sessionID: "session-one", messageID: "message-one" };
  return {
    root, repo, home, policyPath, context,
    remember: async (input, toolContext = context) => JSON.parse(await hooks.tool.continuitydb_remember.execute(input, toolContext)),
    search: async (query) => JSON.parse(await hooks.tool.continuitydb_memory_search.execute({ query }, context)),
    calls: () => readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function inVault(f, action) {
  const vault = new ContextVault(f.home);
  try { return action(vault); }
  finally { vault.close(); }
}

function expireFixtureRecord(f, id) {
  inVault(f, (vault) => vault.runTransaction(() => {
    const record = { ...vault.get(id), expires_at: "2020-01-01T00:00:00.000Z" };
    vault.writeCanonical(record);
    vault.indexRecord(record);
  }));
}

function captureKeys(f) {
  return f.calls().filter(({ args }) => args[0] === "capture")
    .map(({ args }) => args[args.indexOf("--idempotency-key") + 1]);
}

for (const explicit of [false, true]) test(`global capture separates ${explicit ? "explicit request" : "OpenCode message"} retry identity from a fresh observation after expiry`, async () => {
  const f = await fixture();
  try {
    const input = {
      body: "Synthetic working memory observation marker", kind: "working", sensitivity: "private",
      ...(explicit ? { request_id: "observation-one" } : {}),
    };
    const first = await f.remember(input);
    assert.equal(first.duplicate, false);
    assert.equal(first.record.status, "active");
    assert.equal(first.record.tenant_id, "fixture-team");
    assert.equal(first.record.owner_id, "fixture-owner");
    assert.equal((await f.search("observation marker")).results.length, 1);

    const immediateRetry = await f.remember(input);
    assert.equal(immediateRetry.duplicate, true);
    assert.equal(immediateRetry.record.id, first.record.id);
    assert.equal(immediateRetry.record.expires_at, first.record.expires_at);
    assert.equal(immediateRetry.request_id, first.request_id);
    expireFixtureRecord(f, first.record.id);

    const expiredRetry = await f.remember(input, explicit ? { ...f.context, messageID: "retry-message" } : f.context);
    assert.equal(expiredRetry.duplicate, true);
    assert.equal(expiredRetry.record.id, first.record.id);
    assert.equal(expiredRetry.record.expires_at, "2020-01-01T00:00:00.000Z");
    assert.equal((await f.search("observation marker")).results.length, 0);

    const nextInput = { ...input, ...(explicit ? { request_id: "observation-two" } : {}) };
    const nextContext = explicit ? f.context : { ...f.context, messageID: "message-two" };
    const fresh = await f.remember(nextInput, nextContext);
    assert.equal(fresh.duplicate, false);
    assert.notEqual(fresh.record.id, first.record.id);
    assert.ok(Date.parse(fresh.record.expires_at) > Date.now());
    assert.equal((await f.search("observation marker")).results.length, 1);
    assert.equal((await f.remember(input)).record.id, first.record.id);
    assert.deepEqual(captureKeys(f).map((key) => key === captureKeys(f)[0]), [true, true, true, false, true]);

    inVault(f, (vault) => vault.forget(fresh.record.id, "synthetic fixture cleanup check"));
    const forgottenRetry = await f.remember(nextInput, nextContext);
    assert.equal(forgottenRetry.record.id, fresh.record.id);
    assert.equal(forgottenRetry.record.status, "tombstoned");
    assert.equal((await f.search("observation marker")).results.length, 0);
    inVault(f, (vault) => assert.equal(vault.db.prepare("SELECT count(*) AS count FROM memory_records").get().count, 2));
  } finally { f.close(); }
});

test("global capture requires explicit retry identity without stable message context", async () => {
  const f = await fixture();
  try {
    const input = { body: "Synthetic explicit identity fixture", kind: "working", sensitivity: "private" };
    await assert.rejects(f.remember(input, { directory: f.repo }), /requires request_id.*sessionID and messageID/i);
    await assert.rejects(f.remember(input, null), /requires request_id.*sessionID and messageID/i);
    assert.equal(captureKeys(f).length, 0);
    await assert.rejects(f.remember({ ...input, request_id: " " }, { directory: f.repo }), /observation identifier/);
    const first = await f.remember({ ...input, request_id: "context-free-one" }, { directory: f.repo });
    const retry = await f.remember({ ...input, request_id: "context-free-one" }, { directory: f.repo });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.record.id, first.record.id);
    const notAnUpdate = await f.remember({ ...input, request_id: "context-free-one", body: "Different content is not an update request" });
    assert.equal(notAnUpdate.duplicate, true);
    assert.equal(notAnUpdate.record.id, first.record.id);
    assert.equal(notAnUpdate.record.body, input.body);
  } finally { f.close(); }
});

for (const explicit of [false, true]) test(`global capture retains its ${explicit ? "explicit" : "generated"} operation key and committed outcome through canonical recovery`, async () => {
  const f = await fixture({ pending: true });
  try {
    const input = { body: "Synthetic pending projection capture", ...(explicit ? { request_id: "pending-one" } : {}) };
    let requestId;
    await assert.rejects(f.remember(input), (error) => {
      assert.equal(error.code, "CANONICAL_PROJECTION_PENDING");
      assert.equal(error.committed, true);
      assert.equal(error.recovery_pending, true);
      requestId = error.request_id;
      assert.equal(typeof requestId, "string");
      assert.match(error.message, new RegExp(`request_id=${requestId}`));
      assert.doesNotMatch(error.message, /not saved|synthetic private projection detail|EIO/);
      return true;
    });
    const committed = inVault(f, (vault) => {
      const records = vault.db.prepare("SELECT * FROM memory_records").all();
      assert.equal(records.length, 1);
      assert.equal(records[0].status, "active");
      return records[0];
    });
    const retry = await f.remember({ ...input, request_id: requestId }, { ...f.context, messageID: "retry-message" });
    assert.equal(retry.request_id, requestId);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.record.id, committed.id);
    assert.equal(retry.record.expires_at, committed.expires_at);
    assert.equal(captureKeys(f)[0], captureKeys(f)[1]);
    inVault(f, (vault) => {
      assert.equal(vault.db.prepare("SELECT count(*) AS count FROM memory_records").get().count, 1);
      assert.equal(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 0);
      assert.equal(vault.verifyAuditLog().valid, true);
    });
  } finally { f.close(); }
});

test("generated global capture enforces the pinned policy TTL and quota with a restricted child environment", async () => {
  const names = ["CONTINUITYDB_CAPTURE_POLICY_FILE", "CONTINUITYDB_UNRELATED_FIXTURE"];
  const before = names.map((name) => process.env[name]);
  process.env.CONTINUITYDB_CAPTURE_POLICY_FILE = "/unused-runtime-policy.json";
  process.env.CONTINUITYDB_UNRELATED_FIXTURE = "synthetic-unrelated-value";
  let f;
  try {
    f = await fixture({ policy: { working_ttl_seconds: 300, max_records_per_project_per_agent: 100 } });
    const first = await f.remember({ body: "Synthetic configured policy memory", request_id: "policy-one" });
    const ttl = Date.parse(first.record.expires_at) - Date.parse(first.record.created_at);
    assert.ok(ttl >= 299_000 && ttl <= 301_000, `configured TTL must be 300 seconds, got ${ttl}`);
    for (const call of f.calls()) {
      assert.equal(call.policy, f.policyPath);
      assert.equal(call.tenant, "fixture-team");
      assert.equal(call.owner, "fixture-owner");
      assert.equal(call.sensitivities, "private");
      assert.equal(call.inheritedUnrelated, false);
      if (call.args[0] === "capture") assert.equal(call.projects, "service");
    }
    // Populate only this disposable fixture up to the configured minimum quota.
    inVault(f, (vault) => vault.ingestBatch(Array.from({ length: 99 }, (_, index) => ({
      body: `Synthetic quota fixture entry ${index}`, tenant_id: "fixture-team", owner_id: "fixture-owner",
      agent_id: "opencode", namespace_id: "project/service", project_id: "service", type: "working",
    }))));
    await assert.rejects(f.remember({ body: "Synthetic additional quota observation", request_id: "policy-two" }), /capture quota exceeded/);
    assert.equal((await f.remember({ body: "Synthetic configured policy memory", request_id: "policy-one" })).record.id, first.record.id);
  } finally {
    f?.close();
    names.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name];
      else process.env[name] = before[index];
    });
  }
});

test("generated global capture deliberately accepts a runtime policy path when no policy is pinned", async () => {
  const before = process.env.CONTINUITYDB_CAPTURE_POLICY_FILE;
  const root = mkdtempSync(join(tmpdir(), "continuitydb-global-runtime-policy-"));
  const policy = join(root, "policy.json");
  writeFileSync(policy, JSON.stringify({ working_ttl_seconds: 900 }), { mode: 0o600 });
  process.env.CONTINUITYDB_CAPTURE_POLICY_FILE = policy;
  let f;
  try {
    f = await fixture({ runtimePolicy: true });
    const saved = await f.remember({ body: "Synthetic runtime selected policy", request_id: "runtime-one" });
    const ttl = Date.parse(saved.record.expires_at) - Date.parse(saved.record.created_at);
    assert.ok(ttl >= 899_000 && ttl <= 901_000);
    assert.equal(f.calls().find(({ args }) => args[0] === "capture").policy, policy);
  } finally {
    f?.close();
    rmSync(root, { recursive: true, force: true });
    if (before === undefined) delete process.env.CONTINUITYDB_CAPTURE_POLICY_FILE;
    else process.env.CONTINUITYDB_CAPTURE_POLICY_FILE = before;
  }
});
