#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { connectAgents, connectionStatus, SUPPORTED_AGENTS } from "../src/agent-connectors.js";
import { registerProject } from "../src/project-registry.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultExamplesRoot = join(repositoryRoot, "examples");
let examplesRoot = defaultExamplesRoot;
const readRepositoryFile = (path) => {
  invariant(path.startsWith("examples/"), `invalid example path: ${path}`);
  return readFileSync(join(examplesRoot, path.slice("examples/".length)), "utf8");
};
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
  "examples/clients/claude-code.hooks.json",
  "examples/clients/codex.AGENTS.md",
]);
const ALL_TOOLS = Object.freeze([
  "memory_search", "memory_context_pack", "memory_capture", "memory_feedback",
  "handoff_checkpoint", "handoff_latest",
]);
const READ_TOOLS = Object.freeze(["memory_search", "memory_context_pack", "handoff_latest"]);

function invariant(condition, message) {
  if (!condition) throw new Error(`client adapter invariant failed: ${message}`);
}

function discoverClientExamples() {
  const paths = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, relativePath);
      else if (entry.isFile()) paths.push(relativePath);
    }
  };
  walk(join(examplesRoot, "clients"), "examples/clients");
  for (const name of readdirSync(examplesRoot)) {
    if (/^(?:claude-code-hooks|cursor-hooks|mcp(?:\.remote)?\.vscode)\.example\.json$/.test(name)) {
      paths.push(`examples/${name}`);
    }
  }
  return paths.sort();
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
  assert.deepEqual(JSON.parse(readRepositoryFile(GENERATED_EXAMPLES[0])), generatedClaude,
    `${GENERATED_EXAMPLES[0]} does not match the generated hook example`);
  assert.deepEqual(JSON.parse(readRepositoryFile(GENERATED_EXAMPLES[1])), generatedCursor);
  assert.deepEqual(JSON.parse(readRepositoryFile(GENERATED_EXAMPLES[2])), generatedClaude,
    `${GENERATED_EXAMPLES[2]} does not match the generated hook example`);
  assert.equal(readRepositoryFile(GENERATED_EXAMPLES[3]).trimEnd(),
    readFileSync(join(projectDir, "AGENTS.md"), "utf8").trimEnd());
  return [...GENERATED_EXAMPLES];
}

function validateCodexExample(path, transport) {
  const document = parseToml(readRepositoryFile(path));
  const server = document.mcp_servers?.continuitydb;
  invariant(server?.required === true, `${path} must require the ContinuityDB server`);
  assert.deepEqual(server.enabled_tools, ALL_TOOLS, `${path} has a stale tool allowlist`);
  invariant(server.default_tools_approval_mode === "writes", `${path} must retain write approvals`);
  invariant(server.startup_timeout_sec === 10 && server.tool_timeout_sec === 30,
    `${path} has stale timeout settings`);
  if (transport === "remote") {
    invariant(server.url === "https://continuitydb.example/mcp",
      "Codex remote URL must match the documented ContinuityDB endpoint");
    invariant(server.bearer_token_env_var === "CONTINUITYDB_MCP_TOKEN",
      "Codex remote token environment reference is stale");
    assert.deepEqual(server.tools, {
      memory_search: { approval_mode: "auto" },
      memory_context_pack: { approval_mode: "auto" },
      handoff_latest: { approval_mode: "auto" },
    }, `${path} has stale read-tool approval modes`);
  } else {
    invariant(server.command === "continuitydb", "Codex stdio command must be continuitydb");
    assert.deepEqual(server.args, ["mcp", "--home", "/absolute/private/path/continuitydb-data"],
      "Codex stdio arguments are stale");
    assert.deepEqual(server.env, {
      CONTINUITYDB_TENANT_ID: "example-org",
      CONTINUITYDB_PRINCIPAL_ID: "codex-agent-1",
      CONTINUITYDB_OWNER_ID: "example-user",
      CONTINUITYDB_AGENT_ID: "codex",
      CONTINUITYDB_ALLOWED_PROJECTS: "service-a,schema-a",
      CONTINUITYDB_ALLOWED_SENSITIVITIES: "public,private",
    }, "Codex stdio identity or concrete project scope is stale");
  }
}

function validateVersionedExamples() {
  const validated = [];
  const copilot = JSON.parse(readRepositoryFile("examples/clients/copilot.repository-mcp.json"));
  validated.push("examples/clients/copilot.repository-mcp.json");
  const copilotServer = copilot.mcpServers.continuitydb;
  invariant(copilotServer.type === "http" && copilotServer.url === "https://continuitydb.example/mcp",
    "Copilot remote schema or endpoint is invalid");
  assert.deepEqual(copilotServer.tools, READ_TOOLS, "Copilot read-only tool allowlist is stale");
  invariant(copilotServer.headers.Authorization === "Bearer $COPILOT_MCP_CONTINUITYDB_TOKEN",
    "Copilot example must contain only a token placeholder");

  const claude = JSON.parse(readRepositoryFile("examples/clients/claude-code.mcp.json")).mcpServers.continuitydb;
  validated.push("examples/clients/claude-code.mcp.json");
  invariant(claude.type === "http" && claude.url === "https://continuitydb.example/mcp",
    "Claude remote schema or endpoint is invalid");
  invariant(claude.headers.Authorization === "Bearer ${CONTINUITYDB_MCP_TOKEN}",
    "Claude example must contain only a token placeholder");

  const opencode = JSON.parse(readRepositoryFile("examples/clients/opencode.json"));
  validated.push("examples/clients/opencode.json");
  invariant(opencode.$schema === "https://opencode.ai/config.json",
    "OpenCode example schema reference is stale");
  invariant(opencode.mcp.continuitydb.type === "remote"
    && opencode.mcp.continuitydb.url === "https://continuitydb.example/mcp",
  "OpenCode remote schema or endpoint is invalid");
  invariant(opencode.mcp.continuitydb.enabled === true && opencode.mcp.continuitydb.oauth === false
    && opencode.mcp.continuitydb.timeout === 30_000 &&
    opencode.mcp.continuitydb.headers.Authorization === "Bearer {env:CONTINUITYDB_MCP_TOKEN}",
  "OpenCode example must use its environment placeholder");
  assert.deepEqual(opencode.plugin, ["./.opencode/plugins/continuitydb.js"],
    "OpenCode plugin reference must point to the generated project plugin");

  validateCodexExample("examples/clients/codex.remote.config.toml", "remote");
  validated.push("examples/clients/codex.remote.config.toml");
  validateCodexExample("examples/clients/codex.stdio.config.toml", "stdio");
  validated.push("examples/clients/codex.stdio.config.toml");

  const opencodePlugin = readRepositoryFile("examples/clients/opencode-continuitydb.js");
  validated.push("examples/clients/opencode-continuitydb.js");
  const pluginCheck = spawnSync(process.execPath, ["--check", join(examplesRoot, "clients", "opencode-continuitydb.js")],
    { encoding: "utf8" });
  invariant(pluginCheck.status === 0, `OpenCode shipped plugin syntax is invalid: ${pluginCheck.stderr}`);
  invariant(opencodePlugin.includes("experimental.session.compacting") && opencodePlugin.includes("session.idle"),
    "OpenCode shipped plugin example omits lifecycle handlers");
  invariant(opencodePlugin.includes("CONTINUITYDB_PROJECT_ID") && opencodePlugin.includes("not saved"),
    "OpenCode shipped plugin example omits project scope or truthful capture failure");
  invariant(!/raw[_ -]?(?:prompt|transcript)|capture.*(?:prompt|transcript)/i.test(opencodePlugin),
    "OpenCode shipped plugin example contains raw prompt/transcript capture");

  const vscode = JSON.parse(readRepositoryFile("examples/mcp.vscode.example.json"));
  validated.push("examples/mcp.vscode.example.json");
  const vscodeServer = vscode.servers?.continuitydb;
  invariant(vscodeServer?.type === "stdio" && vscodeServer.command === "continuitydb",
    "VS Code stdio example schema or command is invalid");
  assert.deepEqual(vscodeServer.args, ["mcp", "--home", "/absolute/private/path/continuitydb-data"],
    "VS Code stdio example arguments are stale");
  assert.deepEqual(vscodeServer.env, {
    CONTINUITYDB_TENANT_ID: "example-org",
    CONTINUITYDB_PRINCIPAL_ID: "copilot-agent-1",
    CONTINUITYDB_OWNER_ID: "example-user",
    CONTINUITYDB_AGENT_ID: "copilot",
    CONTINUITYDB_ALLOWED_PROJECTS: "service-a,schema-a",
    CONTINUITYDB_ALLOWED_SENSITIVITIES: "public,private",
    CONTINUITYDB_CAPTURE_POLICY_FILE: "/absolute/private/path/capture-policy.json",
  }, "VS Code stdio identity or concrete project scope is stale");
  const remoteVscode = JSON.parse(readRepositoryFile("examples/mcp.remote.vscode.example.json"));
  validated.push("examples/mcp.remote.vscode.example.json");
  assert.deepEqual(remoteVscode, {
    servers: {
      continuitydb: {
        type: "stdio",
        command: "continuitydb",
        args: ["mcp"],
        env: { CONTINUITYDB_HTTP_URL: "http://127.0.0.1:7331" },
      },
    },
  }, "VS Code remote thin-stdio example schema is stale");
  const exampleText = [
    JSON.stringify(copilot),
    JSON.stringify(claude),
    JSON.stringify(opencode),
    ...GENERATED_EXAMPLES.map(readRepositoryFile),
    readRepositoryFile("examples/clients/codex.remote.config.toml"),
    readRepositoryFile("examples/clients/codex.stdio.config.toml"),
    opencodePlugin,
    JSON.stringify(vscode),
    JSON.stringify(remoteVscode),
  ].join("\n");
  invariant(!/Bearer\s+(?!\$|\{env:)[A-Za-z0-9._-]{24,}/.test(exampleText),
    "client examples must not contain a bearer-token value");
  invariant(!/(?:Project scope: `default`|ALLOWED_PROJECTS\s*[=:]\s*["'](?:default|\*)["'])/i.test(exampleText),
    "client examples must use concrete generic project IDs, not a default or wildcard scope");
  return validated;
}

function validateRepositoryAdapters() {
  // `os.tmpdir()` can be exposed through an OS-managed alias (notably
  // `/var` -> `/private/var` on macOS). Canonicalize this validator-owned
  // directory before applying the production project's strict no-symlink
  // policy. User-supplied project paths are never canonicalized here.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "continuitydb-client-validator-")));
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
    const validatedExamples = [
      ...validateGeneratedExamples(projectDir, home),
      ...validateVersionedExamples(),
    ].sort();
    const shippedExamples = discoverClientExamples();
    assert.deepEqual(validatedExamples, shippedExamples,
      "every shipped client example must have an explicit validator");
    return {
      ...result,
      generated_examples: [...GENERATED_EXAMPLES],
      shipped_examples: shippedExamples.length,
      semantically_validated_examples: validatedExamples.length,
      standalone_tree_validator: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function parseExamplesRoot(args) {
  if (args.length === 0) return defaultExamplesRoot;
  if (args.length !== 2 || args[0] !== "--examples-root" || !args[1]) {
    throw new Error("usage: validate-client-adapters.js [--examples-root <path>]");
  }
  return resolve(args[1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  examplesRoot = parseExamplesRoot(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(validateRepositoryAdapters())}\n`);
}
