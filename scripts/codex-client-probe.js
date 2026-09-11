import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";
import { sha256 } from "../src/security.js";

const root = mkdtempSync(join(tmpdir(), "continuitydb-codex-probe-"));
const vault = new ContextVault(join(root, "vault"));
const token = "codex-e2e-fixture-token-value-long-enough";
const policy = join(root, "tokens.json");
let service;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}

async function probeCodex(args, options, endpoint) {
  const child = spawn("codex", args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let exit = null;
  let closeChild;
  const closed = new Promise((resolve) => { closeChild = resolve; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => { exit = code; closeChild(); });
  child.on("error", (error) => { stderr += error.message; exit = -1; closeChild(); });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (endpoint.metrics.initializations > 0 && endpoint.metrics.tool_lists > 0) {
      child.kill("SIGTERM");
      await Promise.race([closed, new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
      })]);
      if (exit === null) {
        child.kill("SIGKILL");
        await closed;
      }
      return;
    }
    if (exit !== null) throw new Error(`Codex exited before MCP discovery (${exit}): ${stderr.slice(-2000)}${stdout.slice(-1000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`Codex did not initialize MCP within 10 seconds: ${stderr.slice(-2000)}`);
}

try {
  writeFileSync(policy, JSON.stringify({ tokens: [{
    token_sha256: sha256(token),
    tenant_id: "interop",
    principal_id: "codex-e2e",
    owner_id: "developer-1",
    agent_id: "codex",
    scopes: ["memory:read"],
    allowed_projects: ["api"],
    allowed_sensitivities: ["private"],
  }] }), { mode: 0o600 });
  chmodSync(policy, 0o600);
  service = createContinuityServer({ vault, host: "127.0.0.1", port: 0, tokenPolicyPath: policy });
  const address = await service.listen();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  await probeCodex([
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "-c", `mcp_servers.continuitydb.url=${JSON.stringify(endpoint)}`,
    "-c", "mcp_servers.continuitydb.bearer_token_env_var=\"CONTINUITYDB_E2E_TOKEN\"",
    "-c", "mcp_servers.continuitydb.required=true",
    "-c", "mcp_servers.continuitydb.enabled_tools=[\"memory_search\"]",
    "-c", "mcp_servers.continuitydb.default_tools_approval_mode=\"auto\"",
    "Wait for the configured MCP server, then report that its tool catalog is available.",
  ], {
    cwd: root,
    env: { ...process.env, CONTINUITYDB_E2E_TOKEN: token },
  }, service.mcpEndpoint);
  const version = (await run("codex", ["--version"])).stdout.trim();
  process.stdout.write(`${JSON.stringify({
    passed: true,
    client: version,
    transport: "streamable-http",
    auth: "bearer",
    verified: ["initialize", "tools/list"],
    model_tool_call: false,
    model_tool_call_reason: "standalone Codex authentication is unavailable in this environment",
  })}\n`);
} finally {
  await service?.close().catch(() => vault.close());
  rmSync(root, { recursive: true, force: true });
}
