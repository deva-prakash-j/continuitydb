import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContextVault } from "./store.js";
import { createEmbedderFromEnv, HybridEngine } from "./embeddings.js";
import { CapturePolicy, loadCapturePolicy } from "./capture-policy.js";
import { normalizeIdentity, TokenBucketLimiter } from "./security.js";
import { createApiClientFromEnv } from "./http-client.js";

const apiClient = createApiClientFromEnv();
const vault = apiClient ? null : new ContextVault();
const engine = apiClient ? null : new HybridEngine(vault, createEmbedderFromEnv());
const server = new McpServer({ name: "continuitydb", version: "0.5.0" });
const tenantId = process.env.CONTINUITYDB_TENANT_ID || process.env.CONTEXT_VAULT_TENANT_ID || "local";
const principalId = process.env.CONTINUITYDB_PRINCIPAL_ID || "local-agent";
const ownerId = process.env.CONTINUITYDB_OWNER_ID || process.env.CONTEXT_VAULT_OWNER_ID || principalId;
const agentId = process.env.CONTINUITYDB_AGENT_ID || principalId;
const allowedProjects = (process.env.CONTINUITYDB_ALLOWED_PROJECTS || process.env.CONTEXT_VAULT_ALLOWED_PROJECTS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedSensitivities = (process.env.CONTINUITYDB_ALLOWED_SENSITIVITIES || process.env.CONTEXT_VAULT_ALLOWED_SENSITIVITIES || "public,private")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const identity = normalizeIdentity({
  tenant_id: tenantId,
  principal_id: principalId,
  owner_id: ownerId,
  agent_id: agentId,
  scopes: ["memory:read", "memory:capture", "memory:feedback"],
  allowed_projects: allowedProjects,
  allowed_sensitivities: allowedSensitivities,
});
const capturePolicy = apiClient ? null : new CapturePolicy(loadCapturePolicy(process.env.CONTINUITYDB_CAPTURE_POLICY_FILE || null));
const captureLimiter = new TokenBucketLimiter({
  capacity: Number(process.env.CONTINUITYDB_MCP_CAPTURE_BURST || 30),
  refillPerSecond: Number(process.env.CONTINUITYDB_MCP_CAPTURE_PER_SECOND || 0.5),
  maxPrincipals: 10_000,
});

function response(value) {
  const structured = Array.isArray(value) ? { results: value } : value;
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: structured,
  };
}

server.registerTool(
  "memory_search",
  {
    description: "Search approved engineering memories in the current project and its explicitly linked dependencies.",
    inputSchema: {
      query: z.string().min(1),
      project_id: z.string().optional(),
      dependency_depth: z.number().int().min(0).max(5).default(2),
      top_k: z.number().int().min(1).max(50).default(8),
      token_budget: z.number().int().min(64).max(32000).default(1200),
      branch: z.string().optional(),
      as_of: z.string().datetime().optional(),
      include_stale: z.boolean().default(false),
    },
  },
  async (input) => response(apiClient
    ? await apiClient.search(input)
    : await engine.search({
      ...input,
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      allowed_projects: allowedProjects,
      allowed_sensitivities: allowedSensitivities,
    })),
);

server.registerTool(
  "memory_context_pack",
  {
    description: "Build a small, cited and token-budgeted context pack for a coding task.",
    inputSchema: {
      task: z.string().min(1),
      project_id: z.string().optional(),
      dependency_depth: z.number().int().min(0).max(5).default(2),
      top_k: z.number().int().min(1).max(50).default(8),
      token_budget: z.number().int().min(64).max(32000).default(1200),
      branch: z.string().optional(),
      as_of: z.string().datetime().optional(),
      include_stale: z.boolean().default(false),
    },
  },
  async (input) => response(apiClient
    ? await apiClient.contextPack(input)
    : await engine.contextPack({
      ...input,
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      allowed_projects: allowedProjects,
      allowed_sensitivities: allowedSensitivities,
    })),
);

server.registerTool(
  "memory_capture",
  {
    description: "Capture project memory through server-side risk policy. Agents cannot choose tenant, owner, namespace, status, source trust, or approval.",
    inputSchema: {
      body: z.string().min(1).max(65_536),
      title: z.string().max(500).optional(),
      project_id: z.string().min(1),
      memory_kind: z.enum(["working", "inference", "git-fact", "decision"]).default("inference"),
      confidence: z.number().min(0).max(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      sensitivity: z.enum(["private", "sensitive", "restricted"]).default("private"),
      ttl_seconds: z.number().int().min(300).max(2_592_000).optional(),
      subject_key: z.string().max(200).optional(),
      repo_path: z.string().max(1024).optional(),
      symbol: z.string().max(500).optional(),
      git_commit: z.string().max(64).optional(),
      branch: z.string().max(200).optional(),
      content_checksum: z.string().length(64).optional(),
      tags: z.array(z.string().max(200)).max(64).optional(),
      idempotency_key: z.string().max(512).optional(),
      observed_at: z.string().datetime().optional(),
    },
  },
  async (input) => {
    if (apiClient) return response(await apiClient.capture(input));
    if (!captureLimiter.consume(`${identity.tenant_id}:${identity.principal_id}:capture`)) {
      throw new Error("capture rate limit exceeded");
    }
    const assessment = capturePolicy.evaluate(input, identity, vault);
    const result = vault.capture(assessment, { actor: `${identity.principal_id}/${identity.agent_id}` });
    let semantic_index = { indexed: false, reason: "memory is not active or semantic retrieval is disabled" };
    if (result.record.status === "active" && engine.embedder) {
      try { semantic_index = await engine.indexMemory(result.record.id); }
      catch (error) { semantic_index = { indexed: false, reason: error.message }; }
    }
    return response({ ...result, semantic_index });
  },
);

server.registerTool(
  "memory_feedback",
  {
    description: "Record bounded, non-destructive feedback on a visible memory. Feedback cannot commit, correct, delete, or change scope.",
    inputSchema: {
      memory_id: z.string().uuid(),
      signal: z.enum(["helpful", "incorrect", "outdated"]),
      reason: z.string().max(2000).optional(),
    },
  },
  async (input) => {
    if (apiClient) return response(await apiClient.feedback(input));
    if (!captureLimiter.consume(`${identity.tenant_id}:${identity.principal_id}:feedback`, 0.25)) {
      throw new Error("feedback rate limit exceeded");
    }
    const memory = vault.get(input.memory_id);
    const visible = memory
      && memory.tenant_id === identity.tenant_id
      && memory.owner_id === identity.owner_id
      && (!memory.project_id || identity.allowed_projects.includes(memory.project_id))
      && identity.allowed_sensitivities.includes(memory.sensitivity);
    if (!visible) throw new Error("active memory not found");
    return response(vault.feedback({
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      principal_id: identity.principal_id,
      agent_id: identity.agent_id,
      ...input,
    }));
  },
);

server.registerTool(
  "handoff_checkpoint",
  {
    description: "Save an explicit, structured task checkpoint for a later session or authorized agent.",
    inputSchema: {
      project_id: z.string().min(1).max(200),
      task_id: z.string().min(1).max(200),
      goal: z.string().min(1).max(4000),
      current_state: z.string().min(1).max(8000),
      completed_work: z.array(z.string().min(1).max(2000)).max(64).default([]),
      unresolved_questions: z.array(z.string().min(1).max(2000)).max(64).default([]),
      next_actions: z.array(z.string().min(1).max(2000)).max(64).default([]),
      relevant_files: z.array(z.string().min(1).max(1024)).max(128).default([]),
      state: z.enum(["in_progress", "blocked", "completed"]).default("in_progress"),
      branch: z.string().max(200).optional(),
      git_commit: z.string().max(64).optional(),
      checkpoint_id: z.string().max(200).optional(),
      sensitivity: z.enum(["private", "sensitive", "restricted"]).default("private"),
    },
  },
  async (input) => {
    if (apiClient) return response(await apiClient.saveHandoff(input));
    if (!captureLimiter.consume(`${identity.tenant_id}:${identity.principal_id}:handoff`)) {
      throw new Error("handoff rate limit exceeded");
    }
    if (!identity.allowed_projects.includes(input.project_id)) throw new Error(`project ${input.project_id} is not allowed for this caller`);
    if (!identity.allowed_sensitivities.includes(input.sensitivity)) throw new Error(`sensitivity ${input.sensitivity} is not allowed for this caller`);
    const handoffInput = {
      ...input,
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      principal_id: identity.principal_id,
      agent_id: identity.agent_id,
    };
    return response(vault.saveHandoff(handoffInput, {
      assessment: capturePolicy.evaluateHandoff(handoffInput, identity, vault),
      actor: `${identity.principal_id}/${identity.agent_id}`,
    }));
  },
);

server.registerTool(
  "handoff_latest",
  {
    description: "Retrieve the newest checkpoint applicable to this task, project, owner and branch.",
    inputSchema: {
      project_id: z.string().min(1).max(200),
      task_id: z.string().min(1).max(200),
      branch: z.string().max(200).optional(),
    },
  },
  async (input) => {
    if (apiClient) return response(await apiClient.latestHandoff(input));
    if (!identity.allowed_projects.includes(input.project_id)) throw new Error(`project ${input.project_id} is not allowed for this caller`);
    const result = vault.latestHandoff({
      ...input,
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      allowed_sensitivities: identity.allowed_sensitivities,
    });
    if (!result) throw new Error("handoff not found");
    return response(result);
  },
);

process.on("SIGINT", () => {
  vault?.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
