import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { hasPrivateDirectoryPermissions } from "./paths.js";

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
  const scopes = Object.freeze([...new Set((input.scopes || ["memory:read"]).filter((scope) => VALID_SCOPES.has(scope)))]);
  const sensitivities = Object.freeze([...new Set(
    (input.allowed_sensitivities || ["public", "private"]).filter((value) => VALID_SENSITIVITIES.has(value)),
  )]);
  const principalId = requiredIdentifier(input.principal_id || "local-user", "principal_id");
  const allowedProjects = Object.freeze(
    [...new Set(input.allowed_projects || [])].map((id) => requiredIdentifier(id, "project_id")),
  );
  return Object.freeze({
    tenant_id: requiredIdentifier(input.tenant_id || "local", "tenant_id"),
    principal_id: principalId,
    owner_id: requiredIdentifier(input.owner_id || principalId, "owner_id"),
    agent_id: input.agent_id ? requiredIdentifier(input.agent_id, "agent_id") : null,
    scopes,
    allowed_projects: allowedProjects,
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

/** Return only the public outcome fields of a committed projection failure. */
export function committedRecoveryOutcome(error) {
  if (error?.code !== "CANONICAL_PROJECTION_PENDING"
    || error.committed !== true || error.recovery_pending !== true) return null;
  return {
    error: "write committed; canonical recovery is pending",
    code: "CANONICAL_PROJECTION_PENDING",
    committed: true,
    recovery_pending: true,
  };
}

/** Validate the unauthenticated local boundary and reuse it for the MCP transport. */
export function loopbackHttpRequestSecurity(headers, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("local HTTP listening port must be an integer between 1 and 65535");
  }
  const names = ["127.0.0.1", "localhost", "[::1]"];
  const allowedHosts = names.flatMap((name) => port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]);
  const allowedOrigins = names.map((name) => `http://${name}${port === 80 ? "" : `:${port}`}`);
  if (typeof headers.host !== "string" || !allowedHosts.includes(headers.host)) {
    throw Object.assign(new Error("Host is not allowed for the local HTTP service"), { code: "FORBIDDEN" });
  }
  if (headers.origin !== undefined
    && (typeof headers.origin !== "string" || !allowedOrigins.includes(headers.origin))) {
    throw Object.assign(new Error("Origin is not allowed for the local HTTP service"), { code: "FORBIDDEN" });
  }
  return { enableDnsRebindingProtection: true, allowedHosts, allowedOrigins };
}

export function loadTokenPolicy(path, { platform = process.platform } = {}) {
  if (!path) return [];
  const mode = statSync(path).mode & 0o777;
  if (!hasPrivateDirectoryPermissions(mode, platform)) {
    throw new Error("token policy file must not be readable or writable by group/other");
  }
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

function secureServiceUrl(value, name) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, query, or fragment`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error(`${name} must use HTTPS unless it is loopback`);
  }
  return url;
}

function stringArrayClaim(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} claim must be an array of strings`);
  }
  return value;
}

export class OidcAuthorizer {
  constructor({ issuer, audience, jwksUrl = null, jwks = null }) {
    secureServiceUrl(issuer, "OIDC issuer");
    this.issuer = issuer;
    if (typeof audience !== "string" || !audience || audience.length > 500 || /\s/.test(audience)) {
      throw new Error("OIDC audience contains invalid characters or length");
    }
    this.audience = audience;
    if (!jwks && !jwksUrl) throw new Error("OIDC JWKS URL is required");
    this.keySet = jwks || createRemoteJWKSet(secureServiceUrl(jwksUrl, "OIDC JWKS URL"));
  }

  async authorize(header) {
    const match = typeof header === "string" && header.match(/^Bearer ([^\s]{24,8192})$/);
    if (!match || match[1].split(".").length !== 3) return null;
    try {
      const { payload } = await jwtVerify(match[1], this.keySet, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
        clockTolerance: 5,
      });
      const scopes = typeof payload.scope === "string"
        ? payload.scope.split(/\s+/).filter(Boolean)
        : stringArrayClaim(payload.scp, "scp");
      if (typeof payload.sub !== "string" || typeof payload.continuitydb_tenant !== "string") {
        throw new Error("OIDC token is missing required subject or tenant claims");
      }
      return normalizeIdentity({
        tenant_id: payload.continuitydb_tenant,
        principal_id: payload.sub,
        owner_id: payload.continuitydb_owner || payload.sub,
        agent_id: payload.continuitydb_agent || null,
        scopes,
        allowed_projects: stringArrayClaim(payload.continuitydb_projects, "continuitydb_projects"),
        allowed_sensitivities: stringArrayClaim(payload.continuitydb_sensitivities, "continuitydb_sensitivities"),
      });
    } catch {
      return null;
    }
  }
}

export function createOidcAuthorizerFromEnv(env = process.env) {
  const values = [env.CONTINUITYDB_OIDC_ISSUER, env.CONTINUITYDB_OIDC_AUDIENCE, env.CONTINUITYDB_OIDC_JWKS_URL];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw new Error("CONTINUITYDB_OIDC_ISSUER, CONTINUITYDB_OIDC_AUDIENCE, and CONTINUITYDB_OIDC_JWKS_URL must be configured together");
  }
  return new OidcAuthorizer({ issuer: values[0], audience: values[1], jwksUrl: values[2] });
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
