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
  }) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100_000) {
      throw new Error("MCP max sessions must be an integer between 1 and 100000");
    }
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 10_000 || sessionTtlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("MCP session TTL must be between 10000 and 86400000 milliseconds");
    }
    this.vault = vault;
    this.engine = engine;
    this.capturePolicy = capturePolicy;
    this.captureLimiter = captureLimiter;
    this.maxSessions = maxSessions;
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
    this.pendingInitializations = 0;
    this.metrics = {
      initializations: 0,
      tool_lists: 0,
      tool_calls: 0,
      terminations: 0,
      identity_mismatches: 0,
    };
  }

  async sweepExpired(now = Date.now()) {
    const expired = [...this.sessions.entries()]
      .filter(([, entry]) => now - entry.lastUsedAt > this.sessionTtlMs);
    for (const [sessionId, entry] of expired) {
      this.sessions.delete(sessionId);
      await entry.server.close().catch(() => entry.transport.close().catch(() => {}));
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
    entry.lastUsedAt = Date.now();
    return { sessionId, entry };
  }

  async handle(request, response, identity, readBody) {
    await this.sweepExpired();
    const resolved = this.entryFor(request, identity);
    if (resolved.error) return rpcError(response, ...resolved.error);

    if (request.method === "POST") {
      const body = await readBody(request);
      const messages = Array.isArray(body) ? body : [body];
      this.metrics.tool_lists += messages.filter((message) => message?.method === "tools/list").length;
      this.metrics.tool_calls += messages.filter((message) => message?.method === "tools/call").length;
      if (resolved.entry) return resolved.entry.transport.handleRequest(request, response, body);
      if (!isInitializeRequest(body)) return rpcError(response, 400, "MCP initialize request required");
      this.metrics.initializations += 1;
      if (this.sessions.size + this.pendingInitializations >= this.maxSessions) {
        return rpcError(response, 503, "MCP session capacity reached");
      }
      this.pendingInitializations += 1;

      let entry;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          entry.lastUsedAt = Date.now();
          this.sessions.set(sessionId, entry);
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
        lastUsedAt: Date.now(),
      };
      transport.onclose = () => {
        const sessionId = transport.sessionId;
        if (sessionId) this.sessions.delete(sessionId);
      };
      try {
        await runtime.server.connect(transport);
        return await transport.handleRequest(request, response, body);
      } catch (error) {
        await runtime.server.close().catch(() => transport.close().catch(() => {}));
        throw error;
      } finally {
        this.pendingInitializations -= 1;
      }
    }

    if (!resolved.entry) return rpcError(response, 400, "MCP session ID required");
    if (request.method === "GET" || request.method === "DELETE") {
      if (request.method === "DELETE") this.metrics.terminations += 1;
      return resolved.entry.transport.handleRequest(request, response);
    }
    response.setHeader("allow", "GET, POST, DELETE");
    return rpcError(response, 405, "Method not allowed");
  }

  async close() {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map((entry) => entry.server.close().catch(() => entry.transport.close().catch(() => {}))));
  }
}
