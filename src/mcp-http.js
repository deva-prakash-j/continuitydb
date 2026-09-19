import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createContinuityMcpServer } from "./mcp-server.js";

const JSON_TYPE = "application/json; charset=utf-8";

function identityKey(identity) {
  return JSON.stringify({
    tenant_id: identity.tenant_id,
    principal_id: identity.principal_id,
    owner_id: identity.owner_id,
    agent_id: identity.agent_id,
    scopes: [...identity.scopes].sort(),
    allowed_projects: [...identity.allowed_projects].sort(),
    allowed_sensitivities: [...identity.allowed_sensitivities].sort(),
  });
}

function rpcError(response, status, message) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
  response.writeHead(status, {
    "content-type": JSON_TYPE,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sessionIdFrom(request) {
  const value = request.headers["mcp-session-id"];
  if (value === undefined) return null;
  if (Array.isArray(value) || typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    return false;
  }
  return value;
}

export class ContinuityMcpHttpEndpoint {
  constructor({
    vault,
    engine,
    capturePolicy,
    captureLimiter,
    maxSessions = Number(process.env.CONTINUITYDB_MCP_MAX_SESSIONS || 1_000),
    sessionTtlMs = Number(process.env.CONTINUITYDB_MCP_SESSION_TTL_MS || 30 * 60 * 1_000),
    sweepIntervalMs = null,
    now = Date.now,
    beforeInitialize = null,
  }) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100_000) {
      throw new Error("MCP max sessions must be an integer between 1 and 100000");
    }
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 10_000 || sessionTtlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("MCP session TTL must be between 10000 and 86400000 milliseconds");
    }
    const effectiveSweepIntervalMs = sweepIntervalMs ?? Math.min(Math.max(Math.floor(sessionTtlMs / 2), 1_000), 30_000);
    if (!Number.isInteger(effectiveSweepIntervalMs) || effectiveSweepIntervalMs < 5 || effectiveSweepIntervalMs > 60_000) {
      throw new Error("MCP sweep interval must be an integer between 5 and 60000 milliseconds");
    }
    if (typeof now !== "function") throw new Error("MCP clock must be a function");
    if (beforeInitialize !== null && typeof beforeInitialize !== "function") {
      throw new Error("MCP initialization hook must be a function");
    }
    this.vault = vault;
    this.engine = engine;
    this.capturePolicy = capturePolicy;
    this.captureLimiter = captureLimiter;
    this.maxSessions = maxSessions;
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.beforeInitialize = beforeInitialize;
    this.sessions = new Map();
    this.pendingInitializations = new Set();
    this.closed = false;
    this.closePromise = null;
    this.metrics = {
      initializations: 0,
      tool_lists: 0,
      tool_calls: 0,
      terminations: 0,
      identity_mismatches: 0,
      expirations: 0,
    };
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired().catch(() => {});
    }, effectiveSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async closeEntry(entry) {
    if (!entry.closePromise) {
      entry.closePromise = entry.server.close()
        .catch(() => entry.transport.close().catch(() => {}));
    }
    return entry.closePromise;
  }

  async sweepExpired(now = this.now()) {
    if (this.closed) return;
    const expired = [...this.sessions.entries()]
      .filter(([, entry]) => entry.inFlight === 0 && now - entry.lastUsedAt >= this.sessionTtlMs);
    for (const [sessionId, entry] of expired) {
      this.sessions.delete(sessionId);
      this.metrics.expirations += 1;
      await this.closeEntry(entry);
    }
  }

  entryFor(request, identity) {
    const sessionId = sessionIdFrom(request);
    if (sessionId === false) return { error: [400, "Invalid MCP session ID"] };
    if (!sessionId) return { sessionId: null, entry: null };
    const entry = this.sessions.get(sessionId);
    if (!entry) return { error: [404, "MCP session not found"] };
    if (entry.identityKey !== identityKey(identity)) {
      this.metrics.identity_mismatches += 1;
      return { error: [403, "MCP session identity mismatch"] };
    }
    return { sessionId, entry };
  }

  async useEntry(entry, operation) {
    entry.inFlight += 1;
    entry.lastUsedAt = this.now();
    try {
      return await operation();
    } finally {
      entry.inFlight -= 1;
      entry.lastUsedAt = this.now();
    }
  }

  async handle(request, response, identity, readBody, transportSecurity = null) {
    if (this.closed) return rpcError(response, 503, "MCP endpoint is closed");
    await this.sweepExpired();
    if (this.closed) return rpcError(response, 503, "MCP endpoint is closed");
    const resolved = this.entryFor(request, identity);
    if (resolved.error) return rpcError(response, ...resolved.error);

    if (request.method === "POST") {
      const body = await readBody(request);
      if (this.closed) return rpcError(response, 503, "MCP endpoint is closed");
      const messages = Array.isArray(body) ? body : [body];
      this.metrics.tool_lists += messages.filter((message) => message?.method === "tools/list").length;
      this.metrics.tool_calls += messages.filter((message) => message?.method === "tools/call").length;
      if (resolved.entry) {
        return this.useEntry(resolved.entry, () => resolved.entry.transport.handleRequest(request, response, body));
      }
      if (!isInitializeRequest(body)) return rpcError(response, 400, "MCP initialize request required");
      this.metrics.initializations += 1;
      if (this.sessions.size + this.pendingInitializations.size >= this.maxSessions) {
        return rpcError(response, 503, "MCP session capacity reached");
      }

      let entry;
      const transport = new StreamableHTTPServerTransport({
        ...transportSecurity,
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          entry.lastUsedAt = this.now();
          if (!this.closed) this.sessions.set(sessionId, entry);
        },
      });
      const runtime = createContinuityMcpServer({
        apiClient: null,
        vault: this.vault,
        engine: this.engine,
        identity,
        capturePolicy: this.capturePolicy,
        captureLimiter: this.captureLimiter,
      });
      entry = {
        transport,
        server: runtime.server,
        identityKey: identityKey(identity),
        lastUsedAt: this.now(),
        inFlight: 1,
        closePromise: null,
      };
      let resolveDone;
      entry.done = new Promise((resolve) => { resolveDone = resolve; });
      this.pendingInitializations.add(entry);
      transport.onclose = () => {
        const sessionId = transport.sessionId;
        if (sessionId) this.sessions.delete(sessionId);
      };
      try {
        await this.beforeInitialize?.(entry);
        if (this.closed) throw new Error("MCP endpoint closed during initialization");
        await runtime.server.connect(transport);
        if (this.closed) throw new Error("MCP endpoint closed during initialization");
        return await transport.handleRequest(request, response, body);
      } catch (error) {
        await this.closeEntry(entry);
        throw error;
      } finally {
        entry.inFlight -= 1;
        entry.lastUsedAt = this.now();
        this.pendingInitializations.delete(entry);
        resolveDone();
      }
    }

    if (!resolved.entry) return rpcError(response, 400, "MCP session ID required");
    if (request.method === "GET" || request.method === "DELETE") {
      if (request.method === "DELETE") this.metrics.terminations += 1;
      return this.useEntry(resolved.entry, () => resolved.entry.transport.handleRequest(request, response));
    }
    response.setHeader("allow", "GET, POST, DELETE");
    return rpcError(response, 405, "Method not allowed");
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const pending = [...this.pendingInitializations];
    const entries = [...new Set([...this.sessions.values(), ...pending])];
    this.sessions.clear();
    this.closePromise = Promise.all([
      ...entries.map((entry) => this.closeEntry(entry)),
      ...pending.map((entry) => entry.done),
    ]).then(() => undefined);
    return this.closePromise;
  }
}
