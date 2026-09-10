import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTokenPolicy, normalizeIdentity, sha256, TokenAuthorizer, TokenBucketLimiter } from "../src/security.js";

test("token authorization returns only server-owned identity", () => {
  const identity = normalizeIdentity({ tenant_id: "acme", principal_id: "agent-1", scopes: ["memory:read"] });
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
