import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";
import { ContinuityApiClient } from "../src/http-client.js";
import { sha256 } from "../src/security.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-test-"));
  const vault = new ContextVault(root);
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    localIdentity: {
      tenant_id: "tenant-a",
      principal_id: "owner-a",
      owner_id: "shared-owner",
      agent_id: "test-agent",
      scopes: ["memory:read", "memory:capture", "memory:feedback", "memory:propose", "memory:approve", "memory:admin", "metrics:read"],
      allowed_projects: ["api", "schema"],
      allowed_sensitivities: ["public", "private"],
    },
    enableReviewUi: true,
  });
  return { root, vault, service };
}

test("HTTP API binds identity server-side and supports approved lifecycle", async () => {
  const f = fixture();
  try {
    const address = await f.service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const proposedResponse = await fetch(`${base}/v1/memories/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-fixture" },
      body: JSON.stringify({
        tenant_id: "attacker-tenant",
        owner_id: "attacker",
        project_id: "api",
        namespace_id: "project/api",
        body: "The API consumes SchemaV2.",
      }),
    });
    assert.equal(proposedResponse.status, 201);
    const proposed = await proposedResponse.json();
    assert.equal(proposed.record.tenant_id, "tenant-a");
    assert.equal(proposed.record.owner_id, "shared-owner");

    const committedResponse = await fetch(`${base}/v1/memories/${proposed.record.id}/commit`, { method: "POST" });
    assert.equal(committedResponse.status, 200);
    const searchResponse = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "SchemaV2", project_id: "api" }),
    });
    assert.equal(searchResponse.status, 200);
    assert.equal((await searchResponse.json()).results.length, 1);

    const denied = await fetch(`${base}/v1/memories/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "payroll", namespace_id: "project/payroll", body: "Should be denied" }),
    });
    assert.equal(denied.status, 403);

    const handoffResponse = await fetch(`${base}/v1/handoffs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "handoff-1" },
      body: JSON.stringify({
        project_id: "api",
        task_id: "schema-v2",
        goal: "Ship SchemaV2",
        current_state: "Schema committed",
        next_actions: ["Regenerate client"],
        branch: "main",
      }),
    });
    assert.equal(handoffResponse.status, 201);
    const latestHandoff = await fetch(`${base}/v1/handoffs/latest?project_id=api&task_id=schema-v2&branch=main`);
    assert.equal(latestHandoff.status, 200);
    assert.equal((await latestHandoff.json()).handoff.current_state, "Schema committed");

    const ui = await fetch(`${base}/ui`);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(await ui.text(), /review inbox/i);
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("review inbox exposes held memories and can explicitly approve quarantined captures", async () => {
  const f = fixture();
  try {
    const held = f.vault.propose({
      tenant_id: "tenant-a",
      owner_id: "shared-owner",
      namespace_id: "project/api",
      project_id: "api",
      body: "Review this proposed context.",
    });
    const quarantined = { ...held.record, id: randomUUID(), status: "quarantined", idempotency_key: null, body: "Review quarantined context.", content_hash: "b".repeat(64) };
    f.vault.writeCanonical(quarantined);
    f.vault.indexRecord(quarantined);
    const address = await f.service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const inbox = await fetch(`${base}/v1/memories?status=proposed,quarantined`);
    assert.equal(inbox.status, 200);
    const memories = (await inbox.json()).memories;
    assert.deepEqual(new Set(memories.map((memory) => memory.status)), new Set(["proposed", "quarantined"]));
    const revised = await fetch(`${base}/v1/memories/${held.record.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "review correction", replacement: { body: "Corrected proposed context.", branch: "main" } }),
    });
    assert.equal(revised.status, 200);
    const revisedMemory = await revised.json();
    assert.equal(revisedMemory.body, "Corrected proposed context.");
    assert.equal(revisedMemory.branch, "main");
    assert.equal(revisedMemory.status, "proposed");
    const approved = await fetch(`${base}/v1/memories/${quarantined.id}/commit`, { method: "POST" });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).status, "active");
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("HTTP client uses the central service instead of constructing a local vault", async () => {
  const f = fixture();
  try {
    const address = await f.service.listen();
    const client = new ContinuityApiClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const captured = await client.capture({
      project_id: "api",
      memory_kind: "working",
      body: "CentralServiceContext is shared.",
      branch: "main",
      idempotency_key: "central-context-1",
    });
    assert.equal(captured.disposition, "active");
    const results = await client.search({ query: "CentralServiceContext", project_id: "api", branch: "main" });
    assert.equal(results.length, 1);
    const handoff = await client.saveHandoff({
      project_id: "api",
      task_id: "central-task",
      goal: "Continue centrally",
      current_state: "Checkpoint stored",
      checkpoint_id: "central-checkpoint-1",
    });
    assert.equal(handoff.handoff.task_id, "central-task");
    assert.equal((await client.latestHandoff({ project_id: "api", task_id: "central-task" })).handoff.current_state, "Checkpoint stored");
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("central HTTP adapter authenticates with a host-injected bearer value", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-token-test-"));
  const vault = new ContextVault(root);
  const token = "fixture-token-value-that-is-long-enough";
  const policy = join(root, "tokens.json");
  writeFileSync(policy, JSON.stringify({ tokens: [{
    token_sha256: sha256(token),
    tenant_id: "tenant-a",
    principal_id: "agent-a",
    owner_id: "owner-a",
    agent_id: "remote-agent",
    scopes: ["memory:read", "memory:capture"],
    allowed_projects: ["api"],
    allowed_sensitivities: ["private"],
  }] }));
  chmodSync(policy, 0o600);
  const service = createContinuityServer({ vault, host: "127.0.0.1", port: 0, tokenPolicyPath: policy });
  try {
    const address = await service.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}/v1/search`, { method: "POST" })).status, 401);
    const client = new ContinuityApiClient({ baseUrl, token });
    await client.capture({ project_id: "api", memory_kind: "working", body: "AuthenticatedCentralContext" });
    assert.equal((await client.search({ query: "AuthenticatedCentralContext", project_id: "api" })).length, 1);
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture-only HTTP identity can auto-capture but cannot approve or administer", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-capture-test-"));
  const vault = new ContextVault(root);
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    localIdentity: {
      tenant_id: "tenant-a",
      principal_id: "agent-a",
      owner_id: "shared-owner",
      agent_id: "coding-agent",
      scopes: ["memory:read", "memory:capture"],
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
    },
  });
  try {
    const address = await service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const capturedResponse = await fetch(`${base}/v1/memories/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "capture-http-1" },
      body: JSON.stringify({
        tenant_id: "attacker",
        owner_id: "attacker",
        namespace_id: "personal/global",
        status: "active",
        source_type: "user-explicit",
        project_id: "api",
        memory_kind: "working",
        body: "SchemaV2 must ship before the API client.",
      }),
    });
    assert.equal(capturedResponse.status, 201);
    const captured = await capturedResponse.json();
    assert.equal(captured.disposition, "active");
    assert.equal(captured.record.tenant_id, "tenant-a");
    assert.equal(captured.record.owner_id, "shared-owner");
    assert.equal(captured.record.namespace_id, "project/api");
    assert.equal(captured.record.source_type, "agent-working");

    const commit = await fetch(`${base}/v1/memories/${captured.record.id}/commit`, { method: "POST" });
    assert.equal(commit.status, 403);
    const proposal = await fetch(`${base}/v1/memories/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "api", namespace_id: "project/api", body: "bypass attempt" }),
    });
    assert.equal(proposal.status, 403);
    const deletion = await fetch(`${base}/v1/memories/${captured.record.id}`, { method: "DELETE" });
    assert.equal(deletion.status, 403);
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-owner HTTP callers cannot access projects or sensitivities outside their grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-acl-test-"));
  const vault = new ContextVault(root);
  const hiddenActive = vault.propose({
    tenant_id: "tenant-a",
    owner_id: "shared-owner",
    namespace_id: "project/secret",
    project_id: "secret",
    sensitivity: "sensitive",
    body: "HiddenProjectFact must remain scoped.",
  });
  vault.commit(hiddenActive.record.id);
  const hiddenProposal = vault.propose({
    tenant_id: "tenant-a",
    owner_id: "shared-owner",
    namespace_id: "project/secret",
    project_id: "secret",
    sensitivity: "sensitive",
    body: "Hidden proposal.",
  });
  const visible = vault.propose({
    tenant_id: "tenant-a",
    owner_id: "shared-owner",
    namespace_id: "project/api",
    project_id: "api",
    sensitivity: "private",
    body: "Visible API fact.",
  });
  vault.commit(visible.record.id);
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    localIdentity: {
      tenant_id: "tenant-a",
      principal_id: "limited-admin",
      owner_id: "shared-owner",
      scopes: ["memory:admin"],
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
    },
  });
  try {
    const address = await service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/v1/memories/${hiddenActive.record.id}`)).status, 404);
    assert.equal((await fetch(`${base}/v1/memories/${hiddenActive.record.id}`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${base}/v1/memories/${hiddenProposal.record.id}/commit`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/v1/memories/${hiddenActive.record.id}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replacement: { body: "tamper" } }),
    })).status, 404);
    assert.equal((await fetch(`${base}/v1/memory-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_memory_id: visible.record.id,
        target_memory_id: hiddenActive.record.id,
        relation: "related",
        provenance: "should fail",
      }),
    })).status, 404);
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-loopback service refuses insecure startup", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-test-"));
  const vault = new ContextVault(root);
  try {
    assert.throws(() => createContinuityServer({ vault, host: "0.0.0.0", port: 0 }), /token policy/);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP adapter rejects credentials in URLs and plaintext remote transport", () => {
  assert.throws(() => new ContinuityApiClient({ baseUrl: "http://example.com" }), /must use HTTPS/);
  assert.throws(() => new ContinuityApiClient({ baseUrl: "https://user:secret@example.com" }), /must not contain credentials/);
});
