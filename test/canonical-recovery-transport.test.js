import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CapturePolicy, loadCapturePolicy } from "../src/capture-policy.js";
import { createContinuityServer } from "../src/http-server.js";
import { ContextVault } from "../src/store.js";

for (const transport of ["http", "mcp"]) test(`${transport} capture reports a committed canonical I/O failure and retries after reopen`, async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-canonical-transport-"));
  const home = join(root, "vault");
  const input = {
    project_id: "fixture-project",
    memory_kind: "working",
    body: "Synthetic transport recovery fixture",
    idempotency_key: "transport-recovery-1",
  };
  let vault = null;
  let service = null;
  let client = null;
  let base;

  async function start() {
    service = createContinuityServer({
      vault, host: "127.0.0.1", port: 0,
      tokenPolicyPath: null, oidcAuthorizer: null, publicUrl: null,
      embedder: null, enableReviewUi: false,
      capturePolicy: new CapturePolicy(loadCapturePolicy(null)),
      localIdentity: {
        tenant_id: "fixture-tenant", owner_id: "fixture-owner",
        principal_id: "fixture-agent", agent_id: "fixture-agent",
        scopes: ["memory:read", "memory:capture"],
        allowed_projects: ["fixture-project"], allowed_sensitivities: ["private"],
      },
    });
    const address = await service.listen();
    base = `http://127.0.0.1:${address.port}`;
    if (transport === "mcp") {
      client = new Client({ name: "canonical-recovery-fixture", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    }
  }

  async function capture() {
    if (client) {
      const result = await client.callTool({ name: "memory_capture", arguments: input });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      return { isError: Boolean(result.isError), body: result.structuredContent };
    }
    const response = await fetch(`${base}/v1/memories/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotency_key },
      body: JSON.stringify(input),
    });
    return { status: response.status, isError: !response.ok, body: await response.json() };
  }

  async function stop() {
    await client?.close();
    client = null;
    if (service) await service.close();
    else vault?.close();
    service = null;
    vault = null;
  }

  try {
    vault = new ContextVault(home);
    await start();
    const originalWrite = vault.writeCanonicalFile;
    const privateCause = "synthetic private canonical path detail";
    let failedWrites = 0;
    vault.writeCanonicalFile = () => {
      failedWrites += 1;
      throw Object.assign(new Error(privateCause), { code: "EIO" });
    };
    let result;
    try { result = await capture(); }
    finally { vault.writeCanonicalFile = originalWrite; }
    assert.equal(failedWrites, 1);
    assert.equal(result.isError, true);
    if (transport === "http") {
      assert.equal(result.status, 503);
      assert.equal(typeof result.body.request_id, "string");
    }
    const { request_id, ...outcome } = result.body;
    assert.deepEqual(outcome, {
      error: "write committed; canonical recovery is pending",
      code: "CANONICAL_PROJECTION_PENDING",
      committed: true,
      recovery_pending: true,
    });
    assert.doesNotMatch(JSON.stringify(result), /synthetic private canonical path detail|EIO|stack|cause/);

    const committed = vault.db.prepare("SELECT * FROM memory_records").all();
    assert.equal(committed.length, 1);
    const id = committed[0].id;
    assert.equal(committed[0].status, "active");
    assert.equal(committed[0].body, input.body);
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 1);
    const canonicalPath = vault.recordPath(id);
    assert.equal(existsSync(canonicalPath), false);

    await stop();
    vault = new ContextVault(home);
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 0);
    const canonicalText = readFileSync(canonicalPath, "utf8");
    const canonical = JSON.parse(canonicalText.split("\n")[1]);
    assert.equal(canonical.id, id);
    assert.equal(canonical.status, "active");
    assert.ok(canonicalText.endsWith(`\n---\n${input.body}\n`));

    await start();
    const retry = await capture();
    assert.equal(retry.isError, false);
    if (transport === "http") assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.record.id, id);
    assert.equal(retry.body.disposition, "active");
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM memory_records").get().count, 1);
    assert.equal(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 0);
    assert.equal(vault.verifyAuditLog().valid, true);
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
