import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContinuityApiClient } from "../src/http-client.js";
import { createContinuityServer } from "../src/http-server.js";
import { saveLifecycleCheckpoint } from "../src/lifecycle-context.js";
import { createContinuityMcpServer } from "../src/mcp-server.js";
import { registerProject } from "../src/project-registry.js";
import { normalizeIdentity } from "../src/security.js";
import { ContextVault } from "../src/store.js";

const UNAVAILABLE = "handoff is unavailable for this identity";
const checkpoint = (task, id) => ({
  project_id: "guarded-project", task_id: task, checkpoint_id: id,
  goal: "Synthetic checkpoint boundary fixture", current_state: "Synthetic state", branch: "main",
});
const activeAssessment = () => ({
  disposition: "active", reason: "trusted synthetic assessment",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});

for (const transport of ["local", "http", "mcp"]) {
  test(`${transport} checkpoint enforces resolved sensitivity for predecessors and duplicates without writes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "continuitydb-checkpoint-sensitivity-"));
    const home = join(root, "vault");
    registerProject(home, { id: "guarded-project", root: join(root, "project"), source: "explicit" }, { apply: true });
    const vault = new ContextVault(home);
    const identity = normalizeIdentity({
      tenant_id: "local", owner_id: "local-user", principal_id: "fixture", agent_id: "fixture",
      scopes: ["memory:read", "memory:capture"], allowed_projects: ["guarded-project"],
      allowed_sensitivities: ["private"],
    });
    let service;
    let runtime;
    let client;
    try {
      let save;
      if (transport === "local") {
        save = (input) => saveLifecycleCheckpoint({
          home, projectId: "guarded-project", checkpoint: input, agentId: "fixture",
          allowedSensitivities: identity.allowed_sensitivities, env: {},
        });
      } else if (transport === "http") {
        service = createContinuityServer({ vault, host: "127.0.0.1", port: 0, localIdentity: identity });
        const address = await service.listen();
        const api = new ContinuityApiClient({ baseUrl: `http://127.0.0.1:${address.port}` });
        save = (input) => api.saveHandoff({ ...input, auto_link_previous: true });
      } else {
        runtime = createContinuityMcpServer({ vault, identity, env: {} });
        client = new Client({ name: "sensitivity-fixture", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await runtime.server.connect(serverTransport);
        await client.connect(clientTransport);
        save = async (input) => {
          const result = await client.callTool({ name: "handoff_checkpoint", arguments: { ...input, auto_link_previous: true } });
          if (result.isError) throw new Error(result.content.map((item) => item.text || "").join("\n"));
          return result.structuredContent;
        };
      }

      // Ordinary private-only progression and historical retry remain allowed.
      const firstInput = checkpoint("allowed-task", "allowed-first");
      const first = await save(firstInput);
      const second = await save(checkpoint("allowed-task", "allowed-second"));
      assert.equal(first.disposition, "active");
      assert.equal(second.disposition, "active");
      assert.equal(second.handoff.previous_checkpoint_id, firstInput.checkpoint_id);
      const retry = await save(firstInput);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.record.id, first.record.id);
      assert.equal(retry.disposition, "superseded");

      // Seed an explicitly approved restricted fixture using trusted library
      // operations, then verify only the patched rejection contract.
      const unavailableInput = checkpoint("unavailable-task", "unavailable-prior");
      const held = vault.saveHandoff({ ...unavailableInput, agent_id: "fixture", sensitivity: "restricted" }, {
        assessment: { disposition: "quarantined", reason: "synthetic reviewed fixture" },
      });
      const unavailable = vault.approve(held.record.id, { actor: "fixture-reviewer" });
      const before = vault.exportJsonl();
      const canonicalBefore = readFileSync(vault.recordPath(unavailable.id), "utf8");
      const auditBefore = vault.verifyAuditLog().events;
      for (const input of [checkpoint("unavailable-task", "new-checkpoint"), unavailableInput]) {
        await assert.rejects(save(input), (error) => {
          assert.equal(error.message, UNAVAILABLE);
          if (transport === "local") assert.equal(error.code, "FORBIDDEN");
          if (transport === "http") assert.equal(error.statusCode, 403);
          assert.doesNotMatch(error.message, /unavailable-prior|restricted|new-checkpoint/);
          return true;
        });
        assert.equal(vault.exportJsonl(), before);
        assert.equal(readFileSync(vault.recordPath(unavailable.id), "utf8"), canonicalBefore);
        assert.equal(vault.verifyAuditLog().events, auditBefore);
        assert.equal(vault.latestHandoff({
          project_id: unavailableInput.project_id, task_id: unavailableInput.task_id,
          branch: unavailableInput.branch, allowed_sensitivities: ["restricted"],
        }).record.id, unavailable.id);
        assert.equal(vault.db.prepare("SELECT count(*) AS count FROM canonical_record_writes").get().count, 0);
      }
    } finally {
      await client?.close();
      await runtime?.server.close();
      if (service) await service.close();
      else vault.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("trusted direct handoff callers retain omitted-option semantics and validate explicit scope", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-handoff-trusted-scope-"));
  const vault = new ContextVault(root);
  try {
    const input = checkpoint("direct-task", "direct-checkpoint");
    assert.throws(() => vault.saveHandoff(input, { assessment: activeAssessment(), allowedSensitivities: "private" }), /array of valid sensitivities/);
    assert.throws(() => vault.saveHandoff(input, { assessment: activeAssessment(), allowedSensitivities: [] }), (error) => error.code === "FORBIDDEN");
    const first = vault.saveHandoff(input, { assessment: activeAssessment() });
    assert.equal(first.disposition, "active");
    assert.equal(vault.saveHandoff(input, { assessment: activeAssessment() }).record.id, first.record.id);
    const heldInput = checkpoint("trusted-reviewed-task", "trusted-reviewed-checkpoint");
    const held = vault.saveHandoff({ ...heldInput, sensitivity: "restricted" }, {
      assessment: { disposition: "quarantined", reason: "trusted synthetic review" },
    });
    vault.approve(held.record.id, { actor: "fixture-reviewer" });
    const successor = vault.saveHandoff({ ...heldInput, checkpoint_id: "trusted-successor", auto_link_previous: true }, {
      assessment: activeAssessment(),
    });
    assert.equal(successor.disposition, "active");
    assert.equal(successor.handoff.previous_checkpoint_id, heldInput.checkpoint_id);
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
