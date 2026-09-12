import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { loadTokenPolicy, normalizeIdentity, OidcAuthorizer, sha256, TokenAuthorizer, TokenBucketLimiter } from "../src/security.js";

test("token authorization returns only server-owned identity", () => {
  const identity = normalizeIdentity({ tenant_id: "acme", principal_id: "agent-1", scopes: ["memory:read"] });
  assert.throws(() => identity.scopes.push("memory:admin"), TypeError);
  assert.throws(() => identity.allowed_projects.push("secret"), TypeError);
  const authorizer = new TokenAuthorizer([{ token_sha256: sha256("test-token-with-at-least-24-chars"), identity }]);
  assert.equal(authorizer.authorize("Bearer test-token-with-at-least-24-chars"), identity);
  assert.equal(authorizer.authorize("Bearer wrong-token-with-at-least-24-chars"), null);
});

test("token bucket enforces a bounded burst and refills", () => {
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 });
  assert.equal(limiter.consume("a", 1, 0), true);
  assert.equal(limiter.consume("a", 1, 0), true);
  assert.equal(limiter.consume("a", 1, 0), false);
  assert.equal(limiter.consume("a", 1, 1000), true);
});

test("token policy rejects group-readable files", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-policy-test-"));
  const path = join(root, "policy.json");
  try {
    writeFileSync(path, JSON.stringify({ tokens: [] }), { mode: 0o644 });
    assert.throws(() => loadTokenPolicy(path), /must not be readable/);
    chmodSync(path, 0o600);
    assert.deepEqual(loadTokenPolicy(path), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token policy does not apply POSIX mode-bit enforcement on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-policy-windows-test-"));
  const path = join(root, "policy.json");
  try {
    writeFileSync(path, JSON.stringify({ tokens: [] }), { mode: 0o644 });
    assert.deepEqual(loadTokenPolicy(path, { platform: "win32" }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OIDC authorization verifies JWTs and maps only signed scoped identity claims", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture-key";
  const issuer = "http://127.0.0.1:9999";
  const audience = "https://continuitydb.example/mcp";
  const authorizer = new OidcAuthorizer({
    issuer,
    audience,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  const token = await new SignJWT({
    continuitydb_tenant: "acme",
    continuitydb_owner: "developer-1",
    continuitydb_agent: "codex",
    continuitydb_projects: ["api", "schema"],
    continuitydb_sensitivities: ["private"],
    scope: "memory:read memory:capture ignored:scope",
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .setSubject("agent-1")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const identity = await authorizer.authorize(`Bearer ${token}`);
  assert.equal(identity.tenant_id, "acme");
  assert.equal(identity.principal_id, "agent-1");
  assert.equal(identity.owner_id, "developer-1");
  assert.deepEqual(identity.scopes, ["memory:read", "memory:capture"]);
  assert.deepEqual(identity.allowed_projects, ["api", "schema"]);

  const wrongAudience = await new SignJWT({ continuitydb_tenant: "acme" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .setSubject("agent-1")
    .setIssuer(issuer)
    .setAudience("wrong-audience")
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.equal(await authorizer.authorize(`Bearer ${wrongAudience}`), null);
  const missingTenant = await new SignJWT({ scope: "memory:read" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .setSubject("agent-1")
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.equal(await authorizer.authorize(`Bearer ${missingTenant}`), null);
});

test("OIDC configuration refuses plaintext non-loopback issuer and partial settings", () => {
  assert.throws(() => new OidcAuthorizer({
    issuer: "http://identity.example",
    audience: "continuitydb",
    jwksUrl: "https://identity.example/jwks",
  }), /HTTPS/);
});
