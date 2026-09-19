import { resolve } from "node:path";
import { CapturePolicy, loadCapturePolicy } from "./capture-policy.js";
import { ContinuityApiClient, validateTokenEnvironmentName } from "./http-client.js";
import { linkCheckpointToLatest } from "./lifecycle-lineage.js";
import { validateProjectId } from "./project-identity.js";
import { listRegisteredProjects } from "./project-registry.js";
import { normalizeIdentity, requiredIdentifier } from "./security.js";
import { ContextVault } from "./store.js";

const MIN_TOKEN_BUDGET = 64;
const MAX_TOKEN_BUDGET = 32_000;
const SENSITIVITIES = new Set(["public", "private", "sensitive", "restricted"]);

function optionalIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return requiredIdentifier(String(value), name);
}

function validatedBudget(value = 1200) {
  const budget = Number(value);
  if (!Number.isInteger(budget) || budget < MIN_TOKEN_BUDGET || budget > MAX_TOKEN_BUDGET) {
    throw new Error(`token_budget must be an integer between ${MIN_TOKEN_BUDGET} and ${MAX_TOKEN_BUDGET}`);
  }
  return budget;
}

function validatedSensitivities(values = ["public", "private"]) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("allowed_sensitivities must be a non-empty list");
  const normalized = [...new Set(values.map(String))];
  if (normalized.some((value) => !SENSITIVITIES.has(value))) {
    throw new Error("allowed_sensitivities contains an invalid value");
  }
  return normalized;
}

function assertRegisteredProject(home, projectId) {
  if (!listRegisteredProjects(home).some((project) => project.id === projectId)) {
    throw new Error(`project ${projectId} is not registered in ${resolve(home)}`);
  }
}

function remoteClient({ remoteUrl, tokenEnv, env }) {
  validateTokenEnvironmentName(tokenEnv, "CONTINUITYDB_HTTP_TOKEN_ENV is required and");
  return new ContinuityApiClient({ baseUrl: remoteUrl, token: env[tokenEnv] || null });
}

/**
 * Load one bounded, project-scoped lifecycle context without depending on a
 * provider-specific output schema. A task id is deliberately optional: it
 * controls handoff lookup only and never blocks normal context recall.
 */
export async function loadLifecycleContext({
  home,
  projectId,
  taskId = null,
  branch = null,
  task,
  tokenBudget = 1200,
  tenantId = "local",
  ownerId = "local-user",
  agentId = "lifecycle-hook",
  allowedSensitivities = ["public", "private"],
  remoteUrl = null,
  tokenEnv = null,
  env = process.env,
}) {
  const fixedProjectId = validateProjectId(projectId);
  const fixedTaskId = optionalIdentifier(taskId, "task_id");
  const fixedBranch = optionalIdentifier(branch, "branch");
  const query = typeof task === "string" && task.trim()
    ? task.trim()
    : `Continue work in project ${fixedProjectId}`;
  const budget = validatedBudget(tokenBudget);
  const identity = {
    tenantId: requiredIdentifier(tenantId, "tenant_id"),
    ownerId: requiredIdentifier(ownerId, "owner_id"),
    agentId: requiredIdentifier(agentId, "agent_id"),
    sensitivities: validatedSensitivities(allowedSensitivities),
  };

  let vault = null;
  const client = remoteUrl
    ? remoteClient({ remoteUrl, tokenEnv, env })
    : (() => {
      if (typeof home !== "string" || !home) throw new Error("CONTINUITYDB_HOME is required for local lifecycle hooks");
      assertRegisteredProject(home, fixedProjectId);
      vault = new ContextVault(home);
      return {
        latestHandoff: (input) => vault.latestHandoff({
          ...input,
          tenant_id: identity.tenantId,
          owner_id: identity.ownerId,
          allowed_sensitivities: identity.sensitivities,
        }),
        contextPack: (input) => vault.contextPack({
          ...input,
          tenant_id: identity.tenantId,
          owner_id: identity.ownerId,
          allowed_projects: [fixedProjectId],
          allowed_sensitivities: identity.sensitivities,
        }),
      };
    })();

  try {
    let handoff = null;
    if (fixedTaskId) {
      try {
        handoff = await client.latestHandoff({
          project_id: fixedProjectId,
          task_id: fixedTaskId,
          branch: fixedBranch,
        });
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }
    const contextPack = await client.contextPack({
      project_id: fixedProjectId,
      task: query,
      branch: fixedBranch,
      token_budget: budget,
      dependency_depth: 2,
      exclude_types: ["handoff"],
    });
    return { handoff, contextPack };
  } finally {
    vault?.close();
  }
}

export async function saveLifecycleCheckpoint({
  home,
  projectId,
  checkpoint,
  agentId = "lifecycle-hook",
  tenantId = "local",
  ownerId = "local-user",
  allowedSensitivities = ["public", "private"],
  remoteUrl = null,
  tokenEnv = null,
  env = process.env,
}) {
  const fixedProjectId = validateProjectId(projectId);
  const fixedAgentId = requiredIdentifier(agentId, "agent_id");
  const fixedTenantId = requiredIdentifier(tenantId, "tenant_id");
  const fixedOwnerId = requiredIdentifier(ownerId, "owner_id");
  const fixedSensitivities = validatedSensitivities(allowedSensitivities);
  if (checkpoint.project_id !== fixedProjectId) {
    throw new Error(`checkpoint project ${checkpoint.project_id || "<missing>"} does not match configured project ${fixedProjectId}`);
  }
  let value = { ...checkpoint };
  if (remoteUrl) {
    const client = remoteClient({ remoteUrl, tokenEnv, env });
    if (!Object.prototype.hasOwnProperty.call(value, "previous_checkpoint_id")) {
      try {
        const latest = await client.latestHandoff({
          project_id: fixedProjectId,
          task_id: value.task_id,
          branch: value.branch || null,
        });
        value = linkCheckpointToLatest(value, latest);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }
    return client.saveHandoff(value);
  }
  if (typeof home !== "string" || !home) throw new Error("CONTINUITYDB_HOME is required for local lifecycle hooks");
  assertRegisteredProject(home, fixedProjectId);
  const vault = new ContextVault(home);
  try {
    const identity = normalizeIdentity({
      tenant_id: fixedTenantId,
      principal_id: fixedAgentId,
      owner_id: fixedOwnerId,
      agent_id: fixedAgentId,
      scopes: ["memory:capture"],
      allowed_projects: [fixedProjectId],
      allowed_sensitivities: fixedSensitivities,
    });
    if (!Object.prototype.hasOwnProperty.call(value, "previous_checkpoint_id")) {
      const latest = vault.latestHandoff({
        tenant_id: identity.tenant_id,
        owner_id: identity.owner_id,
        project_id: fixedProjectId,
        task_id: value.task_id,
        branch: value.branch || null,
        allowed_sensitivities: identity.allowed_sensitivities,
      });
      value = linkCheckpointToLatest(value, latest);
    }
    const input = {
      ...value,
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      principal_id: identity.principal_id,
      agent_id: identity.agent_id,
    };
    const policy = new CapturePolicy(loadCapturePolicy(env.CONTINUITYDB_CAPTURE_POLICY_FILE || null));
    return vault.saveHandoff(input, {
      assessment: policy.evaluateHandoff(input, identity, vault),
      actor: `${identity.principal_id}/${identity.agent_id}`,
    });
  } finally {
    vault.close();
  }
}
