import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runLifecycleHook } from "../src/lifecycle-hook.js";
import { renderOpenCodePlugin } from "../src/opencode-plugin-template.js";
import { registerProject } from "../src/project-registry.js";
import { ContextVault } from "../src/store.js";

const PUBLIC_OUTCOME = {
  error: "write committed; canonical recovery is pending",
  code: "CANONICAL_PROJECTION_PENDING",
  committed: true,
  recovery_pending: true,
};
const PRIVATE_CAUSE = "synthetic EIO at /private-fixture/canonical-record.json";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-checkpoint-outcomes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "vault");
  const file = join(root, "handoff.json");
  const checkpoint = {
    project_id: "outcome-project", task_id: "outcome-task", goal: "Resume the fixture",
    current_state: "Stable checkpoint", checkpoint_id: "outcome-checkpoint-1",
  };
  registerProject(home, { id: checkpoint.project_id, root, source: "explicit" }, { apply: true });
  writeFileSync(file, JSON.stringify(checkpoint));
  const environment = {
    CONTINUITYDB_HTTP_URL: "", CONTINUITYDB_HTTP_TOKEN_ENV: "",
    CONTINUITYDB_CAPTURE_POLICY_FILE: "", CONTINUITYDB_HANDOFF_FILE: file,
    CONTINUITYDB_TASK_ID: "", CONTINUITYDB_TENANT_ID: "local", CONTINUITYDB_OWNER_ID: "local-user",
    CONTINUITYDB_ALLOWED_SENSITIVITIES: "public,private",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { root, home, file, checkpoint };
}

async function invokeHook({ home, file }, extra = []) {
  let stdout = "";
  let stderr = "";
  const code = await runLifecycleHook([
    "checkpoint", "--home", home, "--project", "outcome-project", "--file", file, "--verbose", ...extra,
  ], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr };
}

function pendingRecord(home) {
  const vault = new ContextVault(home, { readOnly: true });
  try {
    const rows = vault.db.prepare("SELECT id, status FROM memory_records").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "active");
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 1);
    return rows[0].id;
  } finally {
    vault.close();
  }
}

function assertRecovery(error) {
  assert.equal(error.message, PUBLIC_OUTCOME.error);
  for (const [key, value] of Object.entries(PUBLIC_OUTCOME)) assert.equal(error[key], value);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error), /not saved|private-fixture|synthetic EIO/i);
  assert.doesNotMatch(JSON.stringify(error), /private-fixture|synthetic EIO/);
  return true;
}

async function generatedPlugin({ root, home }, options = {}) {
  const path = join(root, "plugin.mjs");
  writeFileSync(path, renderOpenCodePlugin({
    projectId: "outcome-project", transport: "http", url: "https://outcome.invalid/mcp",
    tokenEnv: "OUTCOME_TEST_TOKEN", home, ...options,
  }));
  const module = await import(pathToFileURL(path).href);
  return module.ContinuityDBPlugin({ directory: root });
}

function pendingResponse() {
  return new Response(JSON.stringify({
    ...PUBLIC_OUTCOME, error: PRIVATE_CAUSE, cause: { message: PRIVATE_CAUSE },
  }), { status: 503, headers: { "content-type": "application/json" } });
}

test("local checkpoint CLI preserves the sanitized committed outcome and retries the original identity", async (t) => {
  const data = fixture(t);
  const failingWrite = t.mock.method(ContextVault.prototype, "writeCanonicalFile", () => {
    throw Object.assign(new Error(PRIVATE_CAUSE), { code: "EIO" });
  });
  const first = await invokeHook(data);
  failingWrite.mock.restore();
  assert.equal(first.code, 1);
  assert.equal(first.stdout, "");
  assert.deepEqual(JSON.parse(first.stderr), { ...PUBLIC_OUTCOME, command: "checkpoint" });
  assert.doesNotMatch(first.stderr, /private-fixture|synthetic EIO|not saved/i);
  const memoryId = pendingRecord(data.home);

  const retry = await invokeHook(data);
  assert.equal(retry.code, 0);
  assert.equal(retry.stderr, "");
  const outcome = JSON.parse(retry.stdout);
  assert.equal(outcome.saved, true);
  assert.equal(outcome.duplicate, true);
  assert.equal(outcome.memory_id, memoryId);
  assert.equal(outcome.checkpoint_id, data.checkpoint.checkpoint_id);
  assert.deepEqual(JSON.parse(readFileSync(data.file, "utf8")), data.checkpoint);
  const recovered = new ContextVault(data.home, { readOnly: true });
  try {
    assert.equal(recovered.db.prepare("SELECT count(*) AS count FROM memory_records").get().count, 1);
    assert.equal(recovered.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 0);
  } finally {
    recovered.close();
  }
});

test("remote checkpoint CLI preserves only public committed outcome fields", async (t) => {
  const data = fixture(t);
  // Explicit lineage lets this regression run against both lifecycle implementations.
  writeFileSync(data.file, JSON.stringify({ ...data.checkpoint, previous_checkpoint_id: null }));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    return pendingResponse();
  });
  const result = await invokeHook(data, [
    "--http-url", "https://outcome.invalid/", "--http-token-env", "OUTCOME_TEST_TOKEN",
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { ...PUBLIC_OUTCOME, command: "checkpoint" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers["idempotency-key"], data.checkpoint.checkpoint_id);
});

test("generated HTTP checkpoint preserves committed recovery and identical retry requests", async (t) => {
  const data = fixture(t);
  const plugin = await generatedPlugin(data);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return pendingResponse();
    return new Response(JSON.stringify({
      disposition: "active", duplicate: true, record: { id: "committed-memory", status: "active" },
      handoff: data.checkpoint,
    }), { status: 200 });
  });
  await assert.rejects(plugin.event({ event: { type: "session.idle" } }), (error) => {
    assert.equal(error.statusCode, 503);
    return assertRecovery(error);
  });
  const retry = await plugin.event({ event: { type: "session.idle" } });
  assert.equal(retry.saved, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.checkpoint_id, data.checkpoint.checkpoint_id);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "https://outcome.invalid/v1/handoffs");
    assert.equal(request.options.headers["idempotency-key"], data.checkpoint.checkpoint_id);
    assert.deepEqual(JSON.parse(request.options.body), { ...data.checkpoint, auto_link_previous: true });
  }
  assert.equal(requests[0].options.body, requests[1].options.body);
});

test("generated HTTP context request also preserves sanitized committed recovery", async (t) => {
  const data = fixture(t);
  const plugin = await generatedPlugin(data);
  t.mock.method(globalThis, "fetch", async () => pendingResponse());
  const output = { context: [] };
  await assert.rejects(plugin["experimental.session.compacting"]({}, output), assertRecovery);
  assert.deepEqual(output.context, []);
});

test("generated HTTP checkpoint keeps rejected writes distinct from committed recovery", async (t) => {
  const data = fixture(t);
  const plugin = await generatedPlugin(data);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "checkpoint validation rejected", code: "INVALID_INPUT", committed: false, recovery_pending: false,
  }), { status: 400 }));
  await assert.rejects(plugin.event({ event: { type: "session.idle" } }), (error) => {
    assert.match(error.message, /^not saved: checkpoint validation rejected$/);
    assert.equal(error.committed, undefined);
    assert.equal(error.recovery_pending, undefined);
    return true;
  });
});

test("generated stdio preserves real hook recovery diagnostics and retries without a new checkpoint", async (t) => {
  const data = fixture(t);
  const failureFlag = join(data.root, "fail-canonical-write");
  const executable = join(data.root, "hook-wrapper.mjs");
  writeFileSync(failureFlag, "synthetic I/O fixture");
  writeFileSync(executable, `#!${process.execPath}\n`
    + `import { existsSync } from "node:fs";\n`
    + `import { ContextVault } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};\n`
    + `import { runLifecycleHook } from ${JSON.stringify(new URL("../src/lifecycle-hook.js", import.meta.url).href)};\n`
    + `if (existsSync(${JSON.stringify(failureFlag)})) ContextVault.prototype.writeCanonicalFile = function () { throw Object.assign(new Error(${JSON.stringify(PRIVATE_CAUSE)}), { code: "EIO" }); };\n`
    + `process.exitCode = await runLifecycleHook(process.argv.slice(3));\n`);
  chmodSync(executable, 0o700);
  const plugin = await generatedPlugin(data, { transport: "stdio", executable });
  await assert.rejects(plugin.event({ event: { type: "session.idle" } }), assertRecovery);
  const memoryId = pendingRecord(data.home);
  const output = { context: [] };
  await assert.rejects(plugin["experimental.session.compacting"]({}, output), assertRecovery);
  assert.deepEqual(output.context, []);

  rmSync(failureFlag);
  const retry = await plugin.event({ event: { type: "session.idle" } });
  assert.equal(retry.saved, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.memory_id, memoryId);
  assert.equal(retry.checkpoint_id, data.checkpoint.checkpoint_id);
  assert.deepEqual(JSON.parse(readFileSync(data.file, "utf8")), data.checkpoint);
});
