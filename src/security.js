import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const VALID_SENSITIVITIES = new Set(["public", "private", "sensitive", "restricted"]);
const VALID_SCOPES = new Set([
  "memory:read",
  "memory:capture",
  "memory:feedback",
  "memory:propose",
  "memory:approve",
  "memory:admin",
  "metrics:read",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function normalizeIdentity(input = {}) {
  const scopes = [...new Set((input.scopes || ["memory:read"]).filter((scope) => VALID_SCOPES.has(scope)))];
  const sensitivities = [...new Set(
    (input.allowed_sensitivities || ["public", "private"]).filter((value) => VALID_SENSITIVITIES.has(value)),
  )];
  const principalId = requiredIdentifier(input.principal_id || "local-user", "principal_id");
  return Object.freeze({
    tenant_id: requiredIdentifier(input.tenant_id || "local", "tenant_id"),
    principal_id: principalId,
    owner_id: requiredIdentifier(input.owner_id || principalId, "owner_id"),
    agent_id: input.agent_id ? requiredIdentifier(input.agent_id, "agent_id") : null,
    scopes,
    allowed_projects: [...new Set(input.allowed_projects || [])].map((id) => requiredIdentifier(id, "project_id")),
    allowed_sensitivities: sensitivities,
  });
}

export function requiredIdentifier(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error(`${name} contains invalid characters or length`);
  }
  return value;
}

export function requireScope(identity, scope) {
  if (!identity.scopes.includes(scope) && !identity.scopes.includes("memory:admin")) {
    const error = new Error(`missing required scope: ${scope}`);
    error.code = "FORBIDDEN";
    throw error;
  }
}

export function loadTokenPolicy(path) {
  if (!path) return [];
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error("token policy file must not be readable or writable by group/other");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.tokens)) throw new Error("token policy must contain a tokens array");
  return parsed.tokens.map((entry) => {
    if (!/^[a-f0-9]{64}$/i.test(entry.token_sha256 || "")) {
      throw new Error("token_sha256 must be a 64-character SHA-256 hex digest");
    }
    return { token_sha256: entry.token_sha256.toLowerCase(), identity: normalizeIdentity(entry) };
  });
}

export class TokenAuthorizer {
  constructor(entries = []) {
    this.entries = entries;
  }

  authorize(header) {
    const match = typeof header === "string" && header.match(/^Bearer ([^\s]{24,4096})$/);
    if (!match) return null;
    const digest = sha256(match[1]);
    for (const entry of this.entries) {
      if (safeEqualHex(digest, entry.token_sha256)) return entry.identity;
    }
    return null;
  }
}

export class TokenBucketLimiter {
  constructor({ capacity = 120, refillPerSecond = 2, maxPrincipals = 100_000 } = {}) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new Error("rate-limit capacity must be positive");
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) throw new Error("rate-limit refill must be positive");
    if (!Number.isInteger(maxPrincipals) || maxPrincipals <= 0) throw new Error("rate-limit principal capacity must be a positive integer");
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.maxPrincipals = maxPrincipals;
    this.buckets = new Map();
  }

  consume(key, cost = 1, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxPrincipals) this.evictOldest();
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  evictOldest() {
    let oldestKey;
    let oldest = Infinity;
    for (const [key, value] of this.buckets) {
      if (value.updatedAt < oldest) {
        oldest = value.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

export function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
