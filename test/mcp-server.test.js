import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP exposes policy-controlled capture and feedback without admin tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-mcp-test-"));
  const serverPath = new URL("../src/mcp-server.js", import.meta.url).pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      CONTINUITYDB_HOME: root,
      CONTINUITYDB_TENANT_ID: "test",
      CONTINUITYDB_PRINCIPAL_ID: "fixture-agent",
      CONTINUITYDB_OWNER_ID: "fixture-owner",
      CONTINUITYDB_AGENT_ID: "coding-agent",
      CONTINUITYDB_ALLOWED_PROJECTS: "api,schema",
    },
  });
  const client = new Client({ name: "continuitydb-test", version: "0.3.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "memory_capture",
      "memory_context_pack",
      "memory_feedback",
      "memory_search",
    ]);
    assert.equal(tools.tools.some((tool) => /commit|delete|correct|admin/.test(tool.name)), false);
    const captured = await client.callTool({
      name: "memory_capture",
      arguments: {
        project_id: "api",
        memory_kind: "working",
        body: "Publish SchemaV2 before regenerating the API client.",
      },
    });
    assert.equal(captured.structuredContent.disposition, "active");
    assert.equal(captured.structuredContent.record.owner_id, "fixture-owner");
    assert.equal(captured.structuredContent.record.agent_id, "coding-agent");
    const searched = await client.callTool({
      name: "memory_search",
      arguments: { query: "SchemaV2", project_id: "api" },
    });
    assert.equal(searched.structuredContent.results.length, 1);
    const feedback = await client.callTool({
      name: "memory_feedback",
      arguments: { memory_id: captured.structuredContent.record.id, signal: "helpful" },
    });
    assert.equal(feedback.structuredContent.recorded, true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
