import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ContextVault } from "../src/store.js";
import { createContinuityServer } from "../src/http-server.js";

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
      "handoff_checkpoint",
      "handoff_latest",
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
    const handoff = await client.callTool({
      name: "handoff_checkpoint",
      arguments: {
        project_id: "api",
        task_id: "schema-v2",
        goal: "Roll out SchemaV2",
        current_state: "Schema is published",
        next_actions: ["Regenerate the client"],
        branch: "main",
      },
    });
    assert.equal(handoff.structuredContent.handoff.task_id, "schema-v2");
    const conflict = await client.callTool({
      name: "handoff_checkpoint",
      arguments: {
        project_id: "api",
        task_id: "schema-v2",
        goal: "Roll out SchemaV2",
        current_state: "Deploy API before schema",
        checkpoint_id: "schema-v2-conflict",
        branch: "main",
      },
    });
    assert.equal(conflict.structuredContent.disposition, "quarantined");
    const latest = await client.callTool({
      name: "handoff_latest",
      arguments: { project_id: "api", task_id: "schema-v2", branch: "main" },
    });
    assert.equal(latest.structuredContent.handoff.current_state, "Schema is published");
    const continued = await client.callTool({
      name: "handoff_checkpoint",
      arguments: {
        project_id: "api",
        task_id: "schema-v2",
        goal: "Roll out SchemaV2",
        current_state: "Client regenerated",
        checkpoint_id: "schema-v2-next",
        previous_checkpoint_id: handoff.structuredContent.handoff.checkpoint_id,
        branch: "main",
      },
    });
    assert.equal(continued.structuredContent.disposition, "active");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdio MCP can proxy two-agent continuity through one authoritative HTTP service", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-remote-mcp-test-"));
  const vault = new ContextVault(root);
  const service = createContinuityServer({
    vault,
    host: "127.0.0.1",
    port: 0,
    localIdentity: {
      tenant_id: "test",
      principal_id: "remote-agent",
      owner_id: "shared-owner",
      agent_id: "remote-coding-agent",
      scopes: ["memory:read", "memory:capture", "memory:feedback"],
      allowed_projects: ["api"],
      allowed_sensitivities: ["private"],
    },
  });
  let client;
  try {
    const address = await service.listen();
    const serverPath = new URL("../src/mcp-server.js", import.meta.url).pathname;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, CONTINUITYDB_HTTP_URL: `http://127.0.0.1:${address.port}` },
    });
    client = new Client({ name: "continuitydb-remote-test", version: "0.5.0" });
    await client.connect(transport);
    const saved = await client.callTool({
      name: "handoff_checkpoint",
      arguments: {
        project_id: "api",
        task_id: "cross-tool",
        goal: "Continue on another client",
        current_state: "Agent A completed the schema",
        branch: "main",
      },
    });
    assert.equal(saved.structuredContent.record.owner_id, "shared-owner");
    const latest = await client.callTool({
      name: "handoff_latest",
      arguments: { project_id: "api", task_id: "cross-tool", branch: "main" },
    });
    assert.equal(latest.structuredContent.handoff.current_state, "Agent A completed the schema");
    assert.equal(vault.latestHandoff({
      tenant_id: "test",
      owner_id: "shared-owner",
      project_id: "api",
      task_id: "cross-tool",
      branch: "main",
      allowed_sensitivities: ["private"],
    }).record.id, saved.structuredContent.record.id);
  } finally {
    await client?.close().catch(() => {});
    await service.close().catch(() => vault.close());
    rmSync(root, { recursive: true, force: true });
  }
});
