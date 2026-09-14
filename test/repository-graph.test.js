import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRepositoryGraph } from "../src/graph/repository-graph.js";
import { ContextVault } from "../src/store.js";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "continuitydb-repository-graph-"));
  const vaultRoot = mkdtempSync(join(tmpdir(), "continuitydb-repository-vault-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "# Orders\nCommitted graph fixture.\n");
  writeFileSync(join(repo, "pom.xml"), "<project><dependencies><dependency><groupId>org.acme</groupId><artifactId>orders</artifactId></dependency></dependencies></project>");
  writeFileSync(join(repo, "src", "OrderService.java"), "package acme; public class OrderService { public void save() {} }\n");
  writeFileSync(join(repo, "src", "OrderApi.java"), "package acme; public class OrderApi { private OrderService service; public void post() { service.save(); } }\n");
  git(repo, "init");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  commit(repo, "initial");
  return {
    repo,
    vault: new ContextVault(vaultRoot),
    cleanup() {
      this.vault.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
    },
  };
}

function activeNodes(vault, projectId, branch = "master") {
  const generation = vault.activeGraphGeneration({ project_id: projectId, branch });
  return vault.db.prepare("SELECT * FROM graph_nodes WHERE generation_id = ? ORDER BY id").all(generation.id);
}

test("builds graph from committed snapshots and incrementally reuses unchanged files", () => {
  const f = fixture();
  try {
    const branch = git(f.repo, "branch", "--show-current");
    const first = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders" });
    assert.equal(first.scanned_files, 4);
    assert.equal(first.parsed_files, 4);
    assert.equal(first.reused_files, 0);
    assert.ok(first.nodes > 0);
    assert.ok(first.edges > 0);
    assert.equal(f.vault.db.prepare(`
      SELECT count(*) AS count FROM graph_edges e
      JOIN graph_nodes target ON target.generation_id = e.generation_id AND target.id = e.target_id
      WHERE e.generation_id = ? AND e.relation = 'calls' AND e.repo_path = ? AND target.repo_path = ?
    `).get(first.generation_id, "src/OrderApi.java", "src/OrderService.java").count > 0, true);
    const reader = new ContextVault(f.vault.rootDir);
    reader.db.exec("BEGIN");
    const readerGeneration = reader.activeGraphGeneration({ project_id: "orders", branch });

    writeFileSync(join(f.repo, "README.md"), "# Orders\nUnrelated committed text.\n");
    commit(f.repo, "readme");
    const second = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders" });
    assert.equal(second.reused_files, 3);
    assert.equal(second.parsed_files, 1);
    assert.equal(f.vault.activeGraphGeneration({ project_id: "orders", branch }).commit, git(f.repo, "rev-parse", "HEAD"));
    assert.equal(f.vault.graphStatus({ project_id: "orders", branch }).generations.superseded, 1);
    assert.equal(reader.activeGraphGeneration({ project_id: "orders", branch }).id, readerGeneration.id);
    reader.db.exec("ROLLBACK");
    reader.close();
  } finally { f.cleanup(); }
});

test("separates branches and removes only from the newly active projection", () => {
  const f = fixture();
  try {
    const branch = git(f.repo, "branch", "--show-current");
    const first = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders" });
    const removedId = activeNodes(f.vault, "orders", branch).find((node) => node.repo_path === "src/OrderApi.java").id;
    git(f.repo, "mv", "src/OrderApi.java", "src/RenamedApi.java");
    commit(f.repo, "rename api");
    const renamed = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders" });
    assert.equal(renamed.reused_files, 3);
    assert.equal(renamed.parsed_files, 1);
    assert.equal(renamed.removed_files, 1);
    assert.equal(activeNodes(f.vault, "orders", branch).some((node) => node.id === removedId), false);
    assert.equal(f.vault.db.prepare("SELECT count(*) AS count FROM graph_nodes WHERE id = ?").get(removedId).count > 0, true);

    git(f.repo, "rm", "src/RenamedApi.java");
    commit(f.repo, "delete api");
    const deleted = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders" });
    assert.equal(deleted.removed_files, 1);
    assert.equal(deleted.reused_files, 3);

    git(f.repo, "checkout", "-b", "feature/rename", first.commit);
    const feature = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders" });
    assert.equal(feature.parsed_files, 4);
    assert.equal(f.vault.activeGraphGeneration({ project_id: "orders", branch: "feature/rename" }).commit, feature.commit);
    assert.equal(f.vault.activeGraphGeneration({ project_id: "orders", branch }).commit, deleted.commit);
  } finally { f.cleanup(); }
});

test("target-side changes, deletes, and renames reparse dependent callers", () => {
  const change = fixture();
  try {
    buildRepositoryGraph(change.vault, change.repo, { projectId: "orders" });
    writeFileSync(join(change.repo, "src", "OrderService.java"), "package acme; public class OrderService { public void save() {} public void later() {} }\n");
    commit(change.repo, "change target");
    const result = buildRepositoryGraph(change.vault, change.repo, { projectId: "orders" });
    assert.equal(result.parsed_files, 2);
    assert.equal(result.reused_files, 2);
  } finally { change.cleanup(); }

  const deletion = fixture();
  try {
    buildRepositoryGraph(deletion.vault, deletion.repo, { projectId: "orders" });
    git(deletion.repo, "rm", "src/OrderService.java");
    commit(deletion.repo, "delete target");
    const result = buildRepositoryGraph(deletion.vault, deletion.repo, { projectId: "orders" });
    assert.equal(result.parsed_files, 1);
    assert.equal(result.reused_files, 2);
    assert.equal(result.removed_files, 1);
  } finally { deletion.cleanup(); }

  const rename = fixture();
  try {
    buildRepositoryGraph(rename.vault, rename.repo, { projectId: "orders" });
    git(rename.repo, "mv", "src/OrderService.java", "src/RenamedService.java");
    commit(rename.repo, "rename target");
    const result = buildRepositoryGraph(rename.vault, rename.repo, { projectId: "orders" });
    assert.equal(result.parsed_files, 2);
    assert.equal(result.reused_files, 2);
    assert.equal(result.removed_files, 1);
  } finally { rename.cleanup(); }
});

test("invalidated extractors and failed publication keep the active graph readable", () => {
  const f = fixture();
  try {
    const first = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders", extractorVersion: "test-v1" });
    const invalidated = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders", extractorVersion: "test-v2" });
    assert.equal(invalidated.reused_files, 0);
    assert.equal(invalidated.parsed_files, 4);

    const active = f.vault.activeGraphGeneration({ project_id: "orders", branch: git(f.repo, "branch", "--show-current") });
    const publish = f.vault.publishGraph.bind(f.vault);
    f.vault.publishGraph = () => { throw new Error("interrupted before publication"); };
    assert.throws(() => buildRepositoryGraph(f.vault, f.repo, { projectId: "orders", extractorVersion: "test-v3" }), /interrupted/);
    f.vault.publishGraph = publish;
    assert.equal(f.vault.activeGraphGeneration({ project_id: "orders", branch: active.branch }).id, active.id);
    assert.ok(activeNodes(f.vault, "orders", active.branch).length > 0);

    writeFileSync(join(f.repo, "src", "ignored.js"), "export const ignored = true;\n");
    writeFileSync(join(f.repo, "invalid.md"), Buffer.from([0xff, 0x61]));
    commit(f.repo, "unsupported graph source");
    const unsupported = buildRepositoryGraph(f.vault, f.repo, { projectId: "orders", extractorVersion: "test-v2" });
    assert.equal(unsupported.unsupported_files, 2);
    assert.equal(unsupported.reused_files, 4);
    assert.equal(first.nodes > 0, true);
  } finally { f.cleanup(); }
});
