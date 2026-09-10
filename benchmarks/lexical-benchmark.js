import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ContextVault } from "../src/store.js";

const recordCount = Number(process.env.CONTEXT_VAULT_BENCH_RECORDS || 10_000);
const queryCount = Number(process.env.CONTEXT_VAULT_BENCH_QUERIES || 500);
const root = mkdtempSync(join(tmpdir(), "context-vault-bench-"));
const vault = new ContextVault(root);

try {
  const ingestStart = performance.now();
  for (let index = 0; index < recordCount; index += 1) {
    const project = `service-${index % 50}`;
    const proposal = vault.propose({
      body: `Decision ${index}: ${project} uses Contract${index} with Kafka topic event-${index % 200}.`,
      title: `Contract decision ${index}`,
      namespace_id: `project/${project}`,
      project_id: project,
      symbol: `Contract${index}`,
      git_commit: index.toString(16).padStart(8, "0"),
      idempotency_key: `bench-${index}`,
    });
    vault.commit(proposal.record.id);
  }
  const ingestMs = performance.now() - ingestStart;

  const latencies = [];
  for (let index = 0; index < queryCount; index += 1) {
    const target = index % recordCount;
    const started = performance.now();
    const project = `service-${target % 50}`;
    vault.search({ query: `Contract${target}`, project_id: project, allowed_projects: [project], top_k: 5 });
    latencies.push(performance.now() - started);
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  console.log(JSON.stringify({
    records: recordCount,
    queries: queryCount,
    ingest_records_per_second: Math.round(recordCount / (ingestMs / 1000)),
    search_ms: {
      p50: Number(percentile(0.50).toFixed(3)),
      p95: Number(percentile(0.95).toFixed(3)),
      p99: Number(percentile(0.99).toFixed(3)),
    },
  }, null, 2));
} finally {
  vault.close();
  rmSync(root, { recursive: true, force: true });
}
