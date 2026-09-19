import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { ContextVault } from "./store.js";
import { createEmbedderFromEnv, HybridEngine, normalizeSearchRequest } from "./embeddings.js";
import { CapturePolicy, loadCapturePolicy } from "./capture-policy.js";
import { REVIEW_UI } from "./review-ui.js";
import { ContinuityMcpHttpEndpoint } from "./mcp-http.js";
import { VERSION } from "./version.js";
import { isDirectEntrypoint } from "./direct-entry.js";
import {
  isLoopback,
  committedRecoveryOutcome,
  loopbackHttpRequestSecurity,
  loadTokenPolicy,
  normalizeIdentity,
  createOidcAuthorizerFromEnv,
  requireScope,
  TokenAuthorizer,
  TokenBucketLimiter,
} from "./security.js";

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = Number(process.env.CONTINUITYDB_MAX_BODY_BYTES || 1_048_576);
const OAUTH_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

function validatedPublicUrl(value, required = false) {
  if (!value) {
    if (!required) return null;
    throw new Error("CONTINUITYDB_PUBLIC_URL is required when OIDC is configured");
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("CONTINUITYDB_PUBLIC_URL must not contain credentials, query, or fragment");
  if (url.pathname !== "/") throw new Error("CONTINUITYDB_PUBLIC_URL must be an origin without a path");
  if (url.protocol !== "https:") throw new Error("CONTINUITYDB_PUBLIC_URL must use HTTPS");
  return url.href.replace(/\/$/, "");
}

function requestPublicBase(request, configuredPublicUrl) {
  if (configuredPublicUrl) return configuredPublicUrl;
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length > 300 || /[\\/?#@]/.test(hostHeader)) return null;
  try {
    const candidate = new URL(`http://${hostHeader}`);
    return isLoopback(candidate.hostname) ? candidate.origin : null;
  } catch {
    return null;
  }
}

function json(response, status, value, requestId) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": JSON_TYPE,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-request-id": requestId,
  });
  response.end(body);
}

function html(response, status, value, requestId) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-request-id": requestId,
  });
  response.end(value);
}

async function readJson(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("content-type must be application/json"), { statusCode: 415 });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 });
  }
}

function boundedSearch(body, identity) {
  return normalizeSearchRequest(body, identity);
}

function boundedWrite(body, identity, idempotencyKey = null) {
  return {
    ...body,
    tenant_id: identity.tenant_id,
    owner_id: identity.owner_id,
    agent_id: identity.agent_id,
    idempotency_key: body.idempotency_key || idempotencyKey || undefined,
  };
}

function validateWriteScope(body, identity) {
  if (body.project_id && !identity.allowed_projects.includes(body.project_id)) {
    throw Object.assign(new Error(`project ${body.project_id} is not allowed for this caller`), { code: "FORBIDDEN" });
  }
  if (body.sensitivity && !identity.allowed_sensitivities.includes(body.sensitivity)) {
    throw Object.assign(new Error(`sensitivity ${body.sensitivity} is not allowed for this caller`), { code: "FORBIDDEN" });
  }
  const expectedNamespace = body.project_id ? `project/${body.project_id}` : "personal/global";
  if (body.namespace_id && body.namespace_id !== expectedNamespace) {
    throw Object.assign(new Error(`namespace must be ${expectedNamespace} for this write`), { code: "FORBIDDEN" });
  }
}

function isVisibleTo(identity, memory) {
  return Boolean(memory
    && memory.tenant_id === identity.tenant_id
    && memory.owner_id === identity.owner_id
    && (!memory.project_id || identity.allowed_projects.includes(memory.project_id))
    && identity.allowed_sensitivities.includes(memory.sensitivity));
}

function errorStatus(error) {
  if (error.statusCode) return error.statusCode;
  if (error.code === "FORBIDDEN") return 403;
  if (/not found/.test(error.message)) return 404;
  if (/not allowed|missing required scope/.test(error.message)) return 403;
  if (/must|invalid|exceeds|prohibited|not proposed|same tenant/.test(error.message)) return 400;
  return 500;
}

function routeMatch(pathname, pattern) {
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].startsWith(":")) params[expected[index].slice(1)] = decodeURIComponent(actual[index]);
    else if (expected[index] !== actual[index]) return null;
  }
  return params;
}

export function createContinuityServer({
  vault = new ContextVault(),
  host = process.env.CONTINUITYDB_HOST || "127.0.0.1",
  port = Number(process.env.CONTINUITYDB_PORT || 7331),
  tokenPolicyPath = process.env.CONTINUITYDB_TOKEN_POLICY_FILE || null,
  trustProxyTls = process.env.CONTINUITYDB_TRUST_PROXY_TLS === "true",
  localIdentity = null,
  embedder = createEmbedderFromEnv(),
  capturePolicy = new CapturePolicy(loadCapturePolicy(process.env.CONTINUITYDB_CAPTURE_POLICY_FILE || null)),
  limiter = new TokenBucketLimiter(),
  enableReviewUi = process.env.CONTINUITYDB_ENABLE_REVIEW_UI === "true",
  oidcAuthorizer = createOidcAuthorizerFromEnv(),
  publicUrl = process.env.CONTINUITYDB_PUBLIC_URL || null,
  mcpMaxSessions = Number(process.env.CONTINUITYDB_MCP_MAX_SESSIONS || 1_000),
  mcpSessionTtlMs = Number(process.env.CONTINUITYDB_MCP_SESSION_TTL_MS || 30 * 60 * 1_000),
  mcpSweepIntervalMs = null,
  mcpNow = Date.now,
  mcpBeforeInitialize = null,
} = {}) {
  const entries = loadTokenPolicy(tokenPolicyPath);
  if (!isLoopback(host) && ((!entries.length && !oidcAuthorizer) || !trustProxyTls)) {
    throw new Error("non-loopback HTTP requires a token policy or OIDC plus CONTINUITYDB_TRUST_PROXY_TLS=true");
  }
  const configuredPublicUrl = validatedPublicUrl(publicUrl, Boolean(oidcAuthorizer));
  const authorizer = new TokenAuthorizer(entries);
  const usesLocalIdentity = !entries.length && !oidcAuthorizer && isLoopback(host);
  const fallbackIdentity = normalizeIdentity(localIdentity || {
    tenant_id: process.env.CONTINUITYDB_TENANT_ID || "local",
    principal_id: process.env.CONTINUITYDB_PRINCIPAL_ID || "local-user",
    owner_id: process.env.CONTINUITYDB_OWNER_ID || process.env.CONTINUITYDB_PRINCIPAL_ID || "local-user",
    agent_id: process.env.CONTINUITYDB_AGENT_ID || null,
    scopes: enableReviewUi
      ? ["memory:read", "memory:capture", "memory:feedback", "memory:approve", "memory:admin", "metrics:read"]
      : ["memory:read", "memory:capture", "memory:feedback", "metrics:read"],
    allowed_projects: (process.env.CONTINUITYDB_ALLOWED_PROJECTS || "").split(",").filter(Boolean),
    allowed_sensitivities: (process.env.CONTINUITYDB_ALLOWED_SENSITIVITIES || "public,private").split(",").filter(Boolean),
  });
  const engine = new HybridEngine(vault, embedder);
  const mcpEndpoint = new ContinuityMcpHttpEndpoint({
    vault,
    engine,
    capturePolicy,
    captureLimiter: new TokenBucketLimiter({
      capacity: Number(process.env.CONTINUITYDB_MCP_CAPTURE_BURST || 30),
      refillPerSecond: Number(process.env.CONTINUITYDB_MCP_CAPTURE_PER_SECOND || 0.5),
      maxPrincipals: 100_000,
    }),
    maxSessions: mcpMaxSessions,
    sessionTtlMs: mcpSessionTtlMs,
    sweepIntervalMs: mcpSweepIntervalMs,
    now: mcpNow,
    beforeInitialize: mcpBeforeInitialize,
  });
  const metrics = { requests: 0, errors: 0, rate_limited: 0, started_at: Date.now() };

  const server = createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"]?.slice(0, 128) || randomUUID();
    metrics.requests += 1;
    try {
      const transportSecurity = usesLocalIdentity
        ? loopbackHttpRequestSecurity(request.headers, request.socket.localPort)
        : null;
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(response, 200, { status: "ok", service: "continuitydb", version: VERSION }, requestId);
      }

      if (request.method === "GET" && url.pathname === OAUTH_METADATA_PATH && oidcAuthorizer) {
        const base = requestPublicBase(request, configuredPublicUrl);
        if (!base) return json(response, 400, { error: "invalid public resource origin", request_id: requestId }, requestId);
        return json(response, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [oidcAuthorizer.issuer],
          scopes_supported: ["memory:read", "memory:capture", "memory:feedback"],
          bearer_methods_supported: ["header"],
        }, requestId);
      }

      let identity = entries.length ? authorizer.authorize(request.headers.authorization) : null;
      if (!identity && oidcAuthorizer) identity = await oidcAuthorizer.authorize(request.headers.authorization);
      if (!identity && usesLocalIdentity) identity = fallbackIdentity;
      if (!identity) {
        const base = requestPublicBase(request, configuredPublicUrl);
        const metadata = oidcAuthorizer && base ? ` resource_metadata="${base}${OAUTH_METADATA_PATH}"` : "";
        response.setHeader("www-authenticate", `Bearer${metadata}`);
        return json(response, 401, { error: "unauthorized", request_id: requestId }, requestId);
      }
      if (!limiter.consume(`${identity.tenant_id}:${identity.principal_id}`)) {
        metrics.rate_limited += 1;
        response.setHeader("retry-after", "1");
        return json(response, 429, { error: "rate limit exceeded", request_id: requestId }, requestId);
      }

      if (request.method === "GET" && url.pathname === "/readyz") {
        vault.db.prepare("SELECT 1").get();
        return json(response, 200, { status: "ready" }, requestId);
      }
      if (url.pathname === "/mcp") {
        return await mcpEndpoint.handle(request, response, identity, readJson, transportSecurity);
      }
      if (request.method === "GET" && url.pathname === "/ui") {
        if (!enableReviewUi) return json(response, 404, { error: "review UI is disabled", request_id: requestId }, requestId);
        requireScope(identity, "memory:approve");
        return html(response, 200, REVIEW_UI, requestId);
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        requireScope(identity, "metrics:read");
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
        response.end([
          `continuitydb_http_requests_total ${metrics.requests}`,
          `continuitydb_http_errors_total ${metrics.errors}`,
          `continuitydb_http_rate_limited_total ${metrics.rate_limited}`,
          `continuitydb_mcp_sessions ${mcpEndpoint.sessions.size}`,
          `continuitydb_mcp_initializations_total ${mcpEndpoint.metrics.initializations}`,
          `continuitydb_mcp_tool_lists_total ${mcpEndpoint.metrics.tool_lists}`,
          `continuitydb_mcp_tool_calls_total ${mcpEndpoint.metrics.tool_calls}`,
          `continuitydb_mcp_identity_mismatches_total ${mcpEndpoint.metrics.identity_mismatches}`,
          `continuitydb_uptime_seconds ${Math.floor((Date.now() - metrics.started_at) / 1000)}`,
          "",
        ].join("\n"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/stats") {
        requireScope(identity, "memory:admin");
        return json(response, 200, vault.stats({ tenant_id: identity.tenant_id }), requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/memories") {
        requireScope(identity, "memory:approve");
        const statuses = (url.searchParams.get("status") || "proposed,quarantined").split(",").filter(Boolean);
        const projectId = url.searchParams.get("project_id") || null;
        if (projectId && !identity.allowed_projects.includes(projectId)) {
          throw Object.assign(new Error(`project ${projectId} is not allowed for this caller`), { code: "FORBIDDEN" });
        }
        return json(response, 200, { memories: vault.listMemories({
          tenant_id: identity.tenant_id,
          owner_id: identity.owner_id,
          allowed_projects: identity.allowed_projects,
          allowed_sensitivities: identity.allowed_sensitivities,
          statuses,
          project_id: projectId,
          limit: Number(url.searchParams.get("limit") || 100),
        }) }, requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/search") {
        requireScope(identity, "memory:read");
        const body = await readJson(request);
        return json(response, 200, await engine.searchDetailed(boundedSearch(body, identity)), requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/context-packs") {
        requireScope(identity, "memory:read");
        const body = await readJson(request);
        return json(response, 200, await engine.contextPack({
          ...boundedSearch({ ...body, query: body.task }, identity),
          task: body.task,
        }), requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/memories/proposals") {
        requireScope(identity, "memory:propose");
        const body = await readJson(request);
        validateWriteScope(body, identity);
        const result = vault.propose(boundedWrite(body, identity, request.headers["idempotency-key"]), {
          actor: `${identity.principal_id}/${identity.agent_id || "host"}`,
        });
        return json(response, result.duplicate ? 200 : 201, result, requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/memories/captures") {
        requireScope(identity, "memory:capture");
        const body = await readJson(request);
        const assessment = capturePolicy.evaluate({
          ...body,
          idempotency_key: body.idempotency_key || request.headers["idempotency-key"] || undefined,
        }, identity, vault);
        const result = vault.capture(assessment, { actor: `${identity.principal_id}/${identity.agent_id || "agent"}` });
        let semantic_index = { indexed: false, reason: "memory is not active or semantic retrieval is disabled" };
        if (result.record.status === "active" && embedder) {
          try { semantic_index = await engine.indexMemory(result.record.id); }
          catch (error) { semantic_index = { indexed: false, reason: error.message }; }
        }
        return json(response, result.duplicate ? 200 : 201, { ...result, semantic_index }, requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/handoffs") {
        requireScope(identity, "memory:capture");
        const body = await readJson(request);
        validateWriteScope({ project_id: body.project_id, sensitivity: body.sensitivity || "private" }, identity);
        const handoffInput = {
          ...body,
          tenant_id: identity.tenant_id,
          owner_id: identity.owner_id,
          principal_id: identity.principal_id,
          agent_id: identity.agent_id,
          checkpoint_id: body.checkpoint_id || request.headers["idempotency-key"] || undefined,
        };
        const assessment = capturePolicy.evaluateHandoff(handoffInput, identity, vault);
        const result = vault.saveHandoff(handoffInput, {
          assessment,
          actor: `${identity.principal_id}/${identity.agent_id || "agent"}`,
        });
        return json(response, result.duplicate ? 200 : 201, result, requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/handoffs/latest") {
        requireScope(identity, "memory:read");
        const projectId = url.searchParams.get("project_id");
        if (!projectId || !identity.allowed_projects.includes(projectId)) {
          throw Object.assign(new Error("project_id is required and must be allowed for this caller"), { code: "FORBIDDEN" });
        }
        const result = vault.latestHandoff({
          tenant_id: identity.tenant_id,
          owner_id: identity.owner_id,
          project_id: projectId,
          task_id: url.searchParams.get("task_id"),
          branch: url.searchParams.get("branch") || null,
          allowed_sensitivities: identity.allowed_sensitivities,
        });
        return result
          ? json(response, 200, result, requestId)
          : json(response, 404, { error: "handoff not found", request_id: requestId }, requestId);
      }
      const feedbackParams = request.method === "POST" && routeMatch(url.pathname, "/v1/memories/:id/feedback");
      if (feedbackParams) {
        requireScope(identity, "memory:feedback");
        const current = vault.get(feedbackParams.id);
        if (!isVisibleTo(identity, current)) return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        const body = await readJson(request);
        return json(response, 200, vault.feedback({
          tenant_id: identity.tenant_id,
          owner_id: identity.owner_id,
          principal_id: identity.principal_id,
          agent_id: identity.agent_id,
          memory_id: current.id,
          signal: body.signal,
          reason: body.reason || null,
        }), requestId);
      }
      const commitParams = request.method === "POST" && routeMatch(url.pathname, "/v1/memories/:id/commit");
      if (commitParams) {
        requireScope(identity, "memory:approve");
        const current = vault.get(commitParams.id, { includeInactive: true });
        if (!isVisibleTo(identity, current)) {
          return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        }
        const committed = vault.approve(commitParams.id, { actor: identity.principal_id });
        let semantic_index = { indexed: false, reason: "semantic retrieval disabled" };
        if (embedder) {
          try { semantic_index = await engine.indexMemory(committed.id); }
          catch (error) { semantic_index = { indexed: false, reason: error.message }; }
        }
        return json(response, 200, { ...committed, semantic_index }, requestId);
      }
      const revisionParams = request.method === "POST" && routeMatch(url.pathname, "/v1/memories/:id/revisions");
      if (revisionParams) {
        requireScope(identity, "memory:admin");
        const current = vault.get(revisionParams.id, { includeInactive: true });
        if (!isVisibleTo(identity, current)) {
          return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        }
        const body = await readJson(request);
        return json(response, 200, vault.revisePending(
          revisionParams.id,
          body.replacement || {},
          body.reason || "api-review-correction",
          { actor: identity.principal_id },
        ), requestId);
      }
      const memoryParams = routeMatch(url.pathname, "/v1/memories/:id");
      const correctionParams = request.method === "POST" && routeMatch(url.pathname, "/v1/memories/:id/corrections");
      if (correctionParams) {
        requireScope(identity, "memory:admin");
        const current = vault.get(correctionParams.id);
        if (!isVisibleTo(identity, current)) {
          return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        }
        const body = await readJson(request);
        const replacement = body.replacement || body;
        validateWriteScope({ ...current, ...replacement }, identity);
        return json(response, 200, vault.correct(correctionParams.id, replacement, body.reason || "api-correction"), requestId);
      }
      if (request.method === "GET" && memoryParams) {
        requireScope(identity, "memory:read");
        const includeInactive = url.searchParams.get("include_inactive") === "true";
        if (includeInactive) requireScope(identity, "memory:approve");
        const current = vault.get(memoryParams.id, { includeInactive });
        if (!isVisibleTo(identity, current)) {
          return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        }
        return json(response, 200, current, requestId);
      }
      if (request.method === "DELETE" && memoryParams) {
        requireScope(identity, "memory:admin");
        const current = vault.get(memoryParams.id, { includeInactive: true });
        if (!isVisibleTo(identity, current)) {
          return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        }
        return json(response, 200, vault.forget(memoryParams.id, "api-request"), requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/project-links") {
        requireScope(identity, "memory:admin");
        const body = await readJson(request);
        if (!identity.allowed_projects.includes(body.source_project) || !identity.allowed_projects.includes(body.target_project)) {
          throw Object.assign(new Error("both projects must be allowed for this caller"), { code: "FORBIDDEN" });
        }
        return json(response, 201, vault.linkProjects({ ...body, tenant_id: identity.tenant_id }), requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/memory-links") {
        requireScope(identity, "memory:admin");
        const body = await readJson(request);
        const source = vault.get(body.source_memory_id, { includeInactive: true });
        const target = vault.get(body.target_memory_id, { includeInactive: true });
        if (!isVisibleTo(identity, source) || !isVisibleTo(identity, target)) {
          return json(response, 404, { error: "memory not found", request_id: requestId }, requestId);
        }
        return json(response, 201, vault.linkMemories({ ...body, tenant_id: identity.tenant_id }), requestId);
      }
      return json(response, 404, { error: "route not found", request_id: requestId }, requestId);
    } catch (error) {
      metrics.errors += 1;
      const committed = committedRecoveryOutcome(error);
      if (committed) return json(response, 503, { ...committed, request_id: requestId }, requestId);
      const status = errorStatus(error);
      const message = status >= 500 ? "internal server error" : error.message;
      return json(response, status, { error: message, request_id: requestId }, requestId);
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;

  return {
    server,
    vault,
    metrics,
    mcpEndpoint,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      await mcpEndpoint.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      vault.close();
    },
  };
}

if (typeof __CONTINUITYDB_BUNDLE__ === "undefined" && isDirectEntrypoint(import.meta.url)) {
  const service = createContinuityServer();
  const address = await service.listen();
  process.stderr.write(`ContinuityDB listening on ${typeof address === "string" ? address : `${address.address}:${address.port}`}\n`);
  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
