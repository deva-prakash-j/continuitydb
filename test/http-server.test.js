import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";
import { ContinuityApiClient } from "../src/http-client.js";
import { OidcAuthorizer, sha256 } from "../src/security.js";

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
      allowed_sensitivities: ["public", "private", "sensitive"],
    },
    enableReviewUi: true,
  });
  return { root, vault, service };
}

function rawRequest(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("implicit local identity validates the same request boundary before REST, UI, and MCP", async () => {
  const f = fixture();
  try {
    const address = await f.service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await rawRequest(`${base}/readyz`)).status, 200);
    assert.equal((await rawRequest(`${base}/readyz`, { headers: { origin: base } })).status, 200);
    for (const path of ["/readyz", "/ui", "/mcp"]) {
      for (const headers of [{ host: "unlisted.example" }, { origin: "https://unlisted.example" }]) {
        const denied = await rawRequest(`${base}${path}`, { headers });
        assert.equal(denied.status, 403);
        assert.match(JSON.parse(denied.body).error, /not allowed for the local HTTP service/);
      }
    }
    assert.equal(f.service.mcpEndpoint.sessions.size, 0);
    assert.equal(f.service.mcpEndpoint.metrics.initializations, 0);
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("HTTP and its client preserve committed recovery flags without internal details", async () => {
  const f = fixture();
  const flags = { code: "CANONICAL_PROJECTION_PENDING", committed: true, recovery_pending: true };
  f.vault.saveHandoff = () => { throw Object.assign(new Error("private I/O fixture detail"), flags); };
  try {
    const address = await f.service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const input = { project_id: "api", task_id: "outcome-test", goal: "Verify outcome", current_state: "Synthetic state" };
    const response = await fetch(`${base}/v1/handoffs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: "write committed; canonical recovery is pending", ...flags, request_id: body.request_id });
    assert.equal(typeof body.request_id, "string");
    const client = new ContinuityApiClient({ baseUrl: base });
    await assert.rejects(client.saveHandoff(input), (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, body.error);
      for (const [key, value] of Object.entries(flags)) assert.equal(error[key], value);
      return true;
    });
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});

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
    const firstHandoff = await handoffResponse.json();
    const conflictingHandoffResponse = await fetch(`${base}/v1/handoffs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "handoff-2" },
      body: JSON.stringify({
        project_id: "api",
        task_id: "schema-v2",
        goal: "Ship SchemaV2",
        current_state: "Deploy API before schema",
        branch: "main",
      }),
    });
    assert.equal(conflictingHandoffResponse.status, 201);
    assert.equal((await conflictingHandoffResponse.json()).disposition, "quarantined");
    const latestHandoff = await fetch(`${base}/v1/handoffs/latest?project_id=api&task_id=schema-v2&branch=main`);
    assert.equal(latestHandoff.status, 200);
    assert.equal((await latestHandoff.json()).handoff.current_state, "Schema committed");

    const continuedHandoffResponse = await fetch(`${base}/v1/handoffs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "handoff-3" },
      body: JSON.stringify({
        project_id: "api",
        task_id: "schema-v2",
        goal: "Ship SchemaV2",
        current_state: "Client regenerated",
        previous_checkpoint_id: firstHandoff.handoff.checkpoint_id,
        branch: "main",
      }),
    });
    assert.equal(continuedHandoffResponse.status, 201);
    assert.equal((await continuedHandoffResponse.json()).disposition, "active");
    const continuedLatest = await fetch(`${base}/v1/handoffs/latest?project_id=api&task_id=schema-v2&branch=main`);
    assert.equal((await continuedLatest.json()).handoff.current_state, "Client regenerated");

    const sensitiveHandoffResponse = await fetch(`${base}/v1/handoffs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "sensitive-handoff-1" },
      body: JSON.stringify({
        project_id: "api",
        task_id: "sensitive-task",
        goal: "Review restricted details",
        current_state: "Sensitive checkpoint",
        sensitivity: "sensitive",
      }),
    });
    assert.equal(sensitiveHandoffResponse.status, 201);
    const sensitiveHandoff = await sensitiveHandoffResponse.json();
    assert.equal(sensitiveHandoff.disposition, "quarantined");
    assert.equal(sensitiveHandoff.record.status, "quarantined");
    const hiddenSensitive = await fetch(`${base}/v1/handoffs/latest?project_id=api&task_id=sensitive-task`);
    assert.equal(hiddenSensitive.status, 404);

    const ui = await fetch(`${base}/ui`);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(await ui.text(), /review inbox/i);
  } finally {
    await f.service.close().catch(() => f.vault.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("HTTP search validates graph bounds, binds authorization, and returns retrieval metadata", async () => {
  const f = fixture();
  let detailedCalls = 0;
  const originalSearchDetailed = f.vault.searchDetailed.bind(f.vault);
  f.vault.searchDetailed = (input) => {
    detailedCalls += 1;
    return originalSearchDetailed(input);
  };
  try {
    const address = await f.service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const search = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "OrderController",
        project_id: "api",
        retrieval_mode: "graph-first",
        graph_depth: 3,
        graph_max_visited: 25,
        graph_max_paths: 1,
        strict_evidence: true,
      }),
    });
    assert.equal(search.status, 200);
    const value = await search.json();
    assert.deepEqual(value.results, []);
    assert.equal(value.retrieval.requested_mode, "graph-first");
    assert.equal(value.retrieval.fallback_reason, "semantic_unavailable");
    assert.equal(detailedCalls, 1);
    const contextResponse = await fetch(`${base}/v1/context-packs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "OrderController", project_id: "api", retrieval_mode: "graph-only" }),
    });
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.retrieval_mode, "graph-only");
    assert.equal(context.retrieval.requested_mode, "graph-only");
    assert.equal(context.retrieval.semantic_fallback_used, false);

    for (const input of [
      { query: "x", project_id: "api", graph_depth: 4 },
      { query: "x", project_id: "api", graph_max_visited: 2001 },
      { query: "x", project_id: "api", graph_max_paths: 201 },
    ]) {
      const invalid = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(invalid.status, 400);
    }
    const callsBeforeDenied = detailedCalls;
    const denied = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "PayrollController", project_id: "payroll", retrieval_mode: "graph-only" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(detailedCalls, callsBeforeDenied, "authorization must run before graph traversal");
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
    f.vault.runTransaction(() => {
      f.vault.writeCanonical(quarantined);
      f.vault.indexRecord(quarantined);
    });
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

test("HTTP review approval rejects a stale handoff successor with conflict status", async () => {
  const f = fixture();
  try {
    const address = await f.service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const save = async (idempotencyKey, body) => {
      const response = await fetch(`${base}/v1/handoffs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    const common = {
      project_id: "api",
      task_id: "review-race",
      goal: "Preserve compare-and-set approval",
      branch: "main",
    };
    const first = await save("review-race-1", {
      ...common,
      checkpoint_id: "checkpoint-1",
      current_state: "Initial state",
    });
    const held = await save("review-race-2", {
      ...common,
      checkpoint_id: "checkpoint-2",
      previous_checkpoint_id: first.handoff.checkpoint_id,
      current_state: "Sensitive held state",
      sensitivity: "sensitive",
    });
    await save("review-race-3", {
      ...common,
      checkpoint_id: "checkpoint-3",
      previous_checkpoint_id: first.handoff.checkpoint_id,
      current_state: "Winning state",
    });

    const approval = await fetch(`${base}/v1/memories/${held.record.id}/commit`, { method: "POST" });
    assert.equal(approval.status, 409);
    assert.match((await approval.json()).error, /approval lineage conflict/);
    const latest = await fetch(`${base}/v1/handoffs/latest?project_id=api&task_id=review-race&branch=main`);
    assert.equal(latest.status, 200);
    assert.equal((await latest.json()).handoff.checkpoint_id, "checkpoint-3");
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
    const proxied = await rawRequest(`${baseUrl}/readyz`, {
      headers: { host: "continuitydb.example", origin: "https://continuitydb.example", authorization: `Bearer ${token}` },
    });
    assert.equal(proxied.status, 200);
  } finally {
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP service accepts verified OIDC bearer identity and advertises protected-resource metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-oidc-test-"));
  const vault = new ContextVault(root);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "http-fixture-key";
  const issuer = "http://127.0.0.1:9444/";
  const audience = "continuitydb-http-fixture";
  const oidcAuthorizer = new OidcAuthorizer({
    issuer,
    audience,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  assert.throws(
    () => createContinuityServer({ vault, host: "127.0.0.1", port: 0, oidcAuthorizer }),
    /PUBLIC_URL is required when OIDC is configured/,
  );
  const publicUrl = "https://continuitydb.example";
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    oidcAuthorizer,
    publicUrl,
  });
  try {
    const address = await service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${base}/v1/search`, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    assert.equal(
      unauthorized.headers.get("www-authenticate"),
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadata.status, 200);
    const metadataBody = await metadata.json();
    assert.equal(metadataBody.authorization_servers[0], issuer);
    assert.equal(metadataBody.resource, `${publicUrl}/mcp`);
    const hostileMetadata = await rawRequest(`${base}/.well-known/oauth-protected-resource/mcp`, {
      headers: { host: "attacker.example" },
    });
    assert.equal(hostileMetadata.status, 200);
    assert.equal(JSON.parse(hostileMetadata.body).resource, `${publicUrl}/mcp`);
    const hostileUnauthorized = await rawRequest(`${base}/v1/search`, {
      method: "POST",
      headers: { host: "attacker.example" },
    });
    assert.equal(hostileUnauthorized.status, 401);
    assert.equal(
      hostileUnauthorized.headers["www-authenticate"],
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );

    const token = await new SignJWT({
      continuitydb_tenant: "tenant-a",
      continuitydb_owner: "owner-a",
      continuitydb_agent: "claude",
      continuitydb_projects: ["api"],
      continuitydb_sensitivities: ["private"],
      scope: "memory:read",
    })
      .setProtectedHeader({ alg: "RS256", kid: "http-fixture-key" })
      .setSubject("agent-a")
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(privateKey);
    const authorized = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "nothing", project_id: "api" }),
    });
    assert.equal(authorized.status, 200);
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

test("non-loopback static policy remains valid without OIDC public metadata configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-http-static-remote-test-"));
  const policy = join(root, "policy.json");
  writeFileSync(policy, JSON.stringify({ tokens: [{
    token_sha256: sha256("remote-static-fixture-token-long-enough"),
    tenant_id: "tenant-a",
    principal_id: "agent-a",
    scopes: ["memory:read"],
    allowed_projects: ["api"],
    allowed_sensitivities: ["private"],
  }] }), { mode: 0o600 });
  chmodSync(policy, 0o600);
  const vault = new ContextVault(join(root, "vault"));
  try {
    assert.doesNotThrow(() => createContinuityServer({
      vault,
      host: "0.0.0.0",
      port: 0,
      tokenPolicyPath: policy,
      trustProxyTls: true,
    }));
    const fakeOidc = { issuer: "https://identity.example", authorize: async () => null };
    assert.throws(() => createContinuityServer({
      vault,
      host: "127.0.0.1",
      port: 0,
      oidcAuthorizer: fakeOidc,
    }), /PUBLIC_URL/);
    assert.throws(() => createContinuityServer({
      vault,
      host: "0.0.0.0",
      port: 0,
      trustProxyTls: true,
      oidcAuthorizer: fakeOidc,
    }), /PUBLIC_URL/);
    assert.throws(() => createContinuityServer({
      vault,
      host: "0.0.0.0",
      port: 0,
      trustProxyTls: true,
      oidcAuthorizer: fakeOidc,
      publicUrl: "https://continuitydb.example/base",
    }), /origin without a path/);
    assert.throws(() => createContinuityServer({
      vault,
      host: "127.0.0.1",
      port: 0,
      oidcAuthorizer: fakeOidc,
      publicUrl: "http://127.0.0.1:7331",
    }), /must use HTTPS/);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP adapter rejects credentials in URLs and plaintext remote transport", () => {
  assert.throws(() => new ContinuityApiClient({ baseUrl: "http://example.com" }), /must use HTTPS/);
  assert.throws(() => new ContinuityApiClient({ baseUrl: "https://user:secret@example.com" }), /must not contain credentials/);
});
