import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedderFromEnv, HybridEngine } from "../src/embeddings.js";
import { ContextVault } from "../src/store.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(readFileSync(join(directory, "quality-fixture.json"), "utf8"));
const embedder = createEmbedderFromEnv();
if (!embedder) throw new Error("configure CONTINUITYDB_EMBEDDING_PROVIDER and CONTINUITYDB_EMBEDDING_MODEL");
const root = mkdtempSync(join(tmpdir(), "continuitydb-hybrid-quality-"));
const vault = new ContextVault(root);
const engine = new HybridEngine(vault, embedder);

try {
  const ids = new Map();
  for (const item of fixture.records) {
    const projectId = item.project_id || null;
    const proposal = vault.propose({
      ...item,
      namespace_id: item.namespace_id || `project/${projectId}`,
      source_type: "verified-artifact",
      source_uri: projectId ? `git://${projectId}/README.md` : "user://preferences",
      git_commit: projectId ? "fixture-commit" : null,
      idempotency_key: `fixture-${item.key}`,
    });
    vault.commit(proposal.record.id);
    await engine.indexMemory(proposal.record.id);
    ids.set(item.key, proposal.record.id);
  }
  for (const link of fixture.links) vault.linkProjects(link);
  const allowedProjects = fixture.records
    .map((item) => item.project_id)
    .filter((projectId) => projectId && projectId !== "payroll-private");

  const byKind = new Map();
  const failures = [];
  for (const item of fixture.queries) {
    const results = await engine.search({
      query: item.query,
      project_id: item.project_id,
      allowed_projects: allowedProjects,
      top_k: 5,
    });
    const rank = results.findIndex((result) => result.id === ids.get(item.expected));
    const stats = byKind.get(item.kind) || { total: 0, hits: 0, reciprocal_rank: 0 };
    stats.total += 1;
    if (rank >= 0) {
      stats.hits += 1;
      stats.reciprocal_rank += 1 / (rank + 1);
    } else failures.push({ kind: item.kind, query: item.query, expected: item.expected });
    byKind.set(item.kind, stats);
  }

  let isolationViolations = 0;
  for (const probe of fixture.isolation_probes) {
    const results = await engine.search({
      query: probe.query,
      project_id: probe.project_id,
      allowed_projects: allowedProjects,
      top_k: 10,
    });
    if (results.some((result) => result.id === ids.get(probe.forbidden))) isolationViolations += 1;
  }

  const metrics = Object.fromEntries([...byKind].map(([kind, stats]) => [kind, {
    hits: stats.hits,
    total: stats.total,
    recall_at_5: Number((stats.hits / stats.total).toFixed(3)),
    mrr_at_5: Number((stats.reciprocal_rank / stats.total).toFixed(3)),
  }]));
  const totalHits = [...byKind.values()].reduce((sum, item) => sum + item.hits, 0);
  const total = [...byKind.values()].reduce((sum, item) => sum + item.total, 0);
  console.log(JSON.stringify({
    mode: "hybrid lexical+semantic+graph",
    embedder: embedder.id,
    overall_recall_at_5: Number((totalHits / total).toFixed(3)),
    by_kind: metrics,
    isolation_probes: fixture.isolation_probes.length,
    isolation_violations: isolationViolations,
    failures,
  }, null, 2));
  if (isolationViolations > 0) process.exitCode = 2;
} finally {
  vault.close();
  rmSync(root, { recursive: true, force: true });
}
