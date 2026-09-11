import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const json = (path) => JSON.parse(read(path));

const copilot = json("examples/clients/copilot.repository-mcp.json");
const copilotServer = copilot.mcpServers.continuitydb;
assert.equal(copilotServer.type, "http");
assert.match(copilotServer.url, /\/mcp$/);
assert.deepEqual(copilotServer.tools.sort(), ["handoff_latest", "memory_context_pack", "memory_search"]);
assert.equal(copilotServer.headers.Authorization, "Bearer $COPILOT_MCP_CONTINUITYDB_TOKEN");

const claude = json("examples/clients/claude-code.mcp.json").mcpServers.continuitydb;
assert.equal(claude.type, "http");
assert.match(claude.url, /\/mcp$/);
assert.equal(claude.headers.Authorization, "Bearer ${CONTINUITYDB_MCP_TOKEN}");
const claudeHooks = json("examples/clients/claude-code.hooks.json").hooks;
assert.equal(claudeHooks.SessionStart[0].hooks[0].command, "continuitydb-hook");
assert.deepEqual(claudeHooks.SessionStart[0].hooks[0].args, ["session-start", "--client", "claude"]);
assert.equal(claudeHooks.Stop[0].hooks[0].args.includes(".continuitydb-handoff.json"), true);

const opencode = json("examples/clients/opencode.json");
assert.equal(opencode.mcp.continuitydb.type, "remote");
assert.match(opencode.mcp.continuitydb.url, /\/mcp$/);
assert.equal(opencode.mcp.continuitydb.oauth, false);
assert.equal(opencode.mcp.continuitydb.headers.Authorization, "Bearer {env:CONTINUITYDB_MCP_TOKEN}");

for (const path of ["examples/clients/codex.remote.config.toml", "examples/clients/codex.stdio.config.toml"]) {
  const value = read(path);
  assert.match(value, /\[mcp_servers\.continuitydb\]/);
  assert.match(value, /required = true/);
  assert.match(value, /default_tools_approval_mode = "writes"/);
}
assert.match(read("examples/clients/codex.remote.config.toml"), /bearer_token_env_var = "CONTINUITYDB_MCP_TOKEN"/);
assert.doesNotMatch(
  [JSON.stringify(copilot), JSON.stringify(claude), JSON.stringify(opencode)].join("\n"),
  /Bearer\s+(?!\$|\{env:)[A-Za-z0-9._-]{24,}/,
);

process.stdout.write(`${JSON.stringify({ valid: true, clients: ["codex", "copilot", "claude-code", "opencode"] })}\n`);
