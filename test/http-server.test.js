import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";

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
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
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
