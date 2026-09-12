#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { connectAgents, connectionStatus, SUPPORTED_AGENTS } from "../src/agent-connectors.js";
import { registerProject } from "../src/project-registry.js";

const repositoryRoot = new URL("../", import.meta.url);
const readRepositoryFile = (path) => readFileSync(new URL(path, repositoryRoot), "utf8");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const EXPECTED_ASSETS = Object.freeze({
  codex: [".codex/config.toml", "AGENTS.md"],
  claude: [".mcp.json", ".claude/settings.json", "CLAUDE.md"],
  opencode: ["opencode.json", ".opencode/plugins/continuitydb.js", "AGENTS.md"],
  cursor: [".cursor/mcp.json", ".cursor/hooks.json", ".cursor/rules/continuitydb.mdc"],
  copilot: [".vscode/mcp.json", ".github/copilot-instructions.md"],
});

const EXPECTED_MODES = Object.freeze({
  codex: "policy-led",
  claude: "hook-enforced",
  opencode: "plugin+policy",
  cursor: "hook+policy",
  copilot: "policy-led",
});

const POLICY_ASSETS = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/continuitydb.mdc",
  ".github/copilot-instructions.md",
]);

const GENERATED_EXAMPLES = Object.freeze([
  "examples/claude-code-hooks.example.json",
  "examples/cursor-hooks.example.json",
  "examples/clients/codex.AGENTS.md",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`client adapter invariant failed: ${message}`);
}

function portableRelative(root, path) {
  return relative(root, path).split("\\").join("/");
}

function assertPolicyContract(content, path, projectId) {
  invariant(content.includes(`Project scope: \`${projectId}\``), `${path} has the wrong project scope`);
  invariant(/bounded memory_context_pack/.test(content), `${path} omits bounded recall`);
  invariant(/explicitly asks to remember, save, record, or update a durable fact/.test(content),
    `${path} omits explicit governed capture`);
  invariant(/untrusted evidence/.test(content), `${path} does not label recall as untrusted evidence`);
  invariant(/never persist full prompts, conversation records, tool logs/.test(content),
    `${path} permits raw context capture`);
  invariant(/denied, or read-only, say `not saved`/.test(content), `${path} omits truthful not-saved behavior`);
  invariant(/never bypass the restriction/.test(content), `${path} permits a policy bypass`);
}

function validateGeneratedSchemas(projectDir, projectId) {
  const codex = parseToml(readFileSync(join(projectDir, ".codex", "config.toml"), "utf8"));
  invariant(codex.mcp_servers?.continuitydb?.env?.CONTINUITYDB_ALLOWED_PROJECTS === projectId,
    "Codex transport is not fixed to the generated project ID");

  const claudeMcp = readJson(join(projectDir, ".mcp.json"));
  invariant(claudeMcp.mcpServers?.continuitydb?.env?.CONTINUITYDB_ALLOWED_PROJECTS === projectId,
    "Claude transport is not fixed to the generated project ID");
  const claudeHooks = readJson(join(projectDir, ".claude", "settings.json")).hooks;
  const claudeStart = claudeHooks?.SessionStart?.[0]?.hooks?.[0];
  const claudeStop = claudeHooks?.Stop?.[0]?.hooks?.[0];
  invariant(claudeStart?.type === "command" && claudeStart.args?.includes(projectId),
    "Claude SessionStart hook schema or project scope is invalid");
  invariant(claudeStop?.type === "command" && claudeStop.args?.some((value) => value.endsWith(".continuitydb-handoff.json")),
    "Claude Stop hook must use the explicit structured handoff file");

  const opencode = readJson(join(projectDir, "opencode.json"));
  invariant(opencode.mcp?.continuitydb?.type === "local", "OpenCode local MCP schema is invalid");
  invariant(opencode.mcp.continuitydb.environment?.CONTINUITYDB_ALLOWED_PROJECTS === projectId,
    "OpenCode transport is not fixed to the generated project ID");
  invariant(opencode.plugin?.includes("./.opencode/plugins/continuitydb.js"),
    "OpenCode generated plugin is not enabled");
  const plugin = readFileSync(join(projectDir, ".opencode", "plugins", "continuitydb.js"), "utf8");
  invariant(plugin.includes("experimental.session.compacting") && plugin.includes("session.idle"),
    "OpenCode generated plugin omits lifecycle handlers");
  invariant(plugin.includes(JSON.stringify(projectId)), "OpenCode plugin is not fixed to the generated project ID");
  invariant(!/prompt|transcript/i.test(plugin), "OpenCode plugin contains a prompt or transcript ingestion path");

  const cursorMcp = readJson(join(projectDir, ".cursor", "mcp.json"));
  invariant(cursorMcp.mcpServers?.continuitydb?.env?.CONTINUITYDB_ALLOWED_PROJECTS === projectId,
    "Cursor transport is not fixed to the generated project ID");
  const cursorHooks = readJson(join(projectDir, ".cursor", "hooks.json"));
  invariant(cursorHooks.version === 1 && cursorHooks.hooks?.sessionStart?.[0]?.command?.includes(`--project ${projectId}`),
    "Cursor sessionStart hook schema or project scope is invalid");
  invariant(cursorHooks.hooks?.stop?.[0]?.command?.includes(".continuitydb-handoff.json"),
    "Cursor stop hook must use the explicit structured handoff file");

  const copilot = readJson(join(projectDir, ".vscode", "mcp.json"));
  invariant(copilot.servers?.continuitydb?.env?.CONTINUITYDB_ALLOWED_PROJECTS === projectId,
    "Copilot transport is not fixed to the generated project ID");
}

export function validateGeneratedAdapterTree(projectDir, { home, projectId }) {
  const root = resolve(projectDir);
  const status = connectionStatus({ projectDir: root, home, projectId });
  invariant(status.length === SUPPORTED_AGENTS.length, "status does not cover all five supported clients");
  for (const client of SUPPORTED_AGENTS) {
    const item = status.find((entry) => entry.client === client);
    invariant(item?.connected && item.verified && !item.drifted, `${client} generated adapter is not verified`);
    invariant(item.recall_mode === EXPECTED_MODES[client], `${client} has an incorrect recall mode`);
    invariant(item.capture_mode === "explicit-governed", `${client} has an incorrect capture mode`);
    assert.deepEqual(item.assets.map((asset) => portableRelative(root, asset.path)), EXPECTED_ASSETS[client]);
  }

  const uniqueAssets = new Set(status.flatMap((item) => item.assets.map((asset) => portableRelative(root, asset.path))));
  invariant(uniqueAssets.size === 12, "complete adapters must generate exactly 12 unique managed assets");
  for (const asset of uniqueAssets) invariant(existsSync(join(root, asset)), `generated asset is missing: ${asset}`);
  for (const path of POLICY_ASSETS) assertPolicyContract(readFileSync(join(root, path), "utf8"), path, projectId);
  validateGeneratedSchemas(root, projectId);

  const generatedText = [...uniqueAssets].map((path) => readFileSync(join(root, path), "utf8")).join("\n");
  invariant(!/(?:Project scope: `default`|ALLOWED_PROJECTS\s*[=:]\s*["'](?:default|\*)["'])/i.test(generatedText),
    "generated adapters contain a default or wildcard project scope");
  return {
    valid: true,
    clients: [...SUPPORTED_AGENTS],
    generated_assets: uniqueAssets.size,
    managed_policies: POLICY_ASSETS.length,
  };
}

function normalizeGeneratedValue(value, projectDir, home) {
  const text = JSON.stringify(value)
    .replaceAll(projectDir, "/workspace/inventory-service")
    .replaceAll(home, "/absolute/private/path/continuitydb-data");
  return JSON.parse(text);
}

function validateGeneratedExamples(projectDir, home) {
  const generatedClaude = normalizeGeneratedValue(
    readJson(join(projectDir, ".claude", "settings.json")), projectDir, home,
  );
  const generatedCursor = normalizeGeneratedValue(
    readJson(join(projectDir, ".cursor", "hooks.json")), projectDir, home,
  );
  assert.deepEqual(JSON.parse(readRepositoryFile(GENERATED_EXAMPLES[0])), generatedClaude);
  assert.deepEqual(JSON.parse(readRepositoryFile(GENERATED_EXAMPLES[1])), generatedCursor);
  assert.equal(readRepositoryFile(GENERATED_EXAMPLES[2]).trimEnd(),
    readFileSync(join(projectDir, "AGENTS.md"), "utf8").trimEnd());
}

function validateVersionedRemoteExamples() {
  const copilot = JSON.parse(readRepositoryFile("examples/clients/copilot.repository-mcp.json"));
  const copilotServer = copilot.mcpServers.continuitydb;
  invariant(copilotServer.type === "http" && /\/mcp$/.test(copilotServer.url), "Copilot remote schema is invalid");
  assert.deepEqual([...copilotServer.tools].sort(), ["handoff_latest", "memory_context_pack", "memory_search"]);
  invariant(copilotServer.headers.Authorization === "Bearer $COPILOT_MCP_CONTINUITYDB_TOKEN",
    "Copilot example must contain only a token placeholder");

  const claude = JSON.parse(readRepositoryFile("examples/clients/claude-code.mcp.json")).mcpServers.continuitydb;
  invariant(claude.type === "http" && /\/mcp$/.test(claude.url), "Claude remote schema is invalid");
  invariant(claude.headers.Authorization === "Bearer ${CONTINUITYDB_MCP_TOKEN}",
    "Claude example must contain only a token placeholder");

  const opencode = JSON.parse(readRepositoryFile("examples/clients/opencode.json"));
  invariant(opencode.mcp.continuitydb.type === "remote" && /\/mcp$/.test(opencode.mcp.continuitydb.url),
    "OpenCode remote schema is invalid");
  invariant(opencode.mcp.continuitydb.oauth === false &&
    opencode.mcp.continuitydb.headers.Authorization === "Bearer {env:CONTINUITYDB_MCP_TOKEN}",
  "OpenCode example must use its environment placeholder");

  for (const path of ["examples/clients/codex.remote.config.toml", "examples/clients/codex.stdio.config.toml"]) {
    const value = readRepositoryFile(path);
    invariant(/\[mcp_servers\.continuitydb\]/.test(value) && /required = true/.test(value), `${path} is incomplete`);
    invariant(/default_tools_approval_mode = "writes"/.test(value), `${path} omits write approval mode`);
  }
  invariant(/bearer_token_env_var = "CONTINUITYDB_MCP_TOKEN"/.test(
    readRepositoryFile("examples/clients/codex.remote.config.toml")), "Codex remote example omits token reference");
  const exampleText = [
    JSON.stringify(copilot),
    JSON.stringify(claude),
    JSON.stringify(opencode),
    ...GENERATED_EXAMPLES.map(readRepositoryFile),
    readRepositoryFile("examples/clients/codex.remote.config.toml"),
    readRepositoryFile("examples/clients/codex.stdio.config.toml"),
  ].join("\n");
  invariant(!/Bearer\s+(?!\$|\{env:)[A-Za-z0-9._-]{24,}/.test(exampleText),
    "client examples must not contain a bearer-token value");
  invariant(!/(?:Project scope: `default`|ALLOWED_PROJECTS\s*[=:]\s*["'](?:default|\*)["'])/i.test(exampleText),
    "client examples must use concrete generic project IDs, not a default or wildcard scope");
}

function validateRepositoryAdapters() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-client-validator-"));
  const projectDir = join(root, "inventory-service");
  const home = join(root, "vault");
  const projectId = "inventory-service";
  try {
    mkdirSync(projectDir, { recursive: true });
    registerProject(home, { id: projectId, root: projectDir, source: "explicit" }, { apply: true });
    connectAgents(SUPPORTED_AGENTS, {
      projectDir,
      home,
      projectId,
      tenantId: "example-org",
      ownerId: "example-user",
      apply: true,
    });
    const result = validateGeneratedAdapterTree(projectDir, { home, projectId });
    validateGeneratedExamples(projectDir, home);
    validateVersionedRemoteExamples();
    return {
      ...result,
      generated_examples: [...GENERATED_EXAMPLES],
      standalone_tree_validator: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(validateRepositoryAdapters())}\n`);
}
