import { isLoopback } from "./security.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function serviceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ContinuityDB service URL must not contain credentials, query, or fragment");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("ContinuityDB service URL must use HTTP or HTTPS");
  if (!isLoopback(url.hostname) && url.protocol !== "https:") {
    throw new Error("remote ContinuityDB service URL must use HTTPS");
  }
  return new URL(url.pathname.endsWith("/") ? url.href : `${url.href}/`);
}

export class ContinuityApiClient {
  constructor({ baseUrl, token = null, timeoutMs = 15_000 }) {
    this.baseUrl = serviceUrl(baseUrl);
    this.token = token;
    this.timeoutMs = Number(timeoutMs);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new Error("ContinuityDB HTTP timeout must be between 100 and 120000 milliseconds");
    }
  }

  async request(path, { method = "GET", body = null, idempotencyKey = null } = {}) {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    const headers = { accept: "application/json" };
    if (body !== null) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_RESPONSE_BYTES) throw new Error("ContinuityDB response is too large");
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await response.body.cancel().catch(() => {});
          throw new Error("ContinuityDB response is too large");
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    const bytes = Buffer.concat(chunks, size);
    let value = {};
    if (bytes.byteLength) {
      try { value = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error(`ContinuityDB returned invalid JSON (HTTP ${response.status})`); }
    }
    if (!response.ok) {
      const error = new Error(value.error || `ContinuityDB returned HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return value;
  }

  async search(input) {
    const value = await this.request("v1/search", { method: "POST", body: input });
    return value.results || [];
  }

  contextPack(input) {
    return this.request("v1/context-packs", { method: "POST", body: input });
  }

  capture(input) {
    return this.request("v1/memories/captures", {
      method: "POST",
      body: input,
      idempotencyKey: input.idempotency_key || null,
    });
  }

  feedback(input) {
    return this.request(`v1/memories/${encodeURIComponent(input.memory_id)}/feedback`, {
      method: "POST",
      body: { signal: input.signal, reason: input.reason },
    });
  }

  saveHandoff(input) {
    return this.request("v1/handoffs", {
      method: "POST",
      body: input,
      idempotencyKey: input.checkpoint_id || null,
    });
  }

  latestHandoff(input) {
    const query = new URLSearchParams({ project_id: input.project_id, task_id: input.task_id });
    if (input.branch) query.set("branch", input.branch);
    return this.request(`v1/handoffs/latest?${query}`);
  }
}

export function createApiClientFromEnv(env = process.env) {
  if (!env.CONTINUITYDB_HTTP_URL) return null;
  const tokenEnv = env.CONTINUITYDB_HTTP_TOKEN_ENV || "CONTINUITYDB_HTTP_TOKEN";
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)
    || ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "PWD"].includes(tokenEnv)) {
    throw new Error("CONTINUITYDB_HTTP_TOKEN_ENV must name a dedicated uppercase environment entry");
  }
  return new ContinuityApiClient({
    baseUrl: env.CONTINUITYDB_HTTP_URL,
    token: env[tokenEnv] || null,
    timeoutMs: env.CONTINUITYDB_HTTP_TIMEOUT_MS ? Number(env.CONTINUITYDB_HTTP_TIMEOUT_MS) : 15_000,
  });
}
