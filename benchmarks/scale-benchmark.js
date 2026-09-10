import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createContinuityServer } from "../src/http-server.js";
import { TokenBucketLimiter } from "../src/security.js";
import { ContextVault } from "../src/store.js";

function argumentsFrom(argv) {
  return Object.fromEntries(argv.map((argument) => {
    const match = argument.match(/^--([a-z-]+)=(.*)$/);
    if (!match) throw new Error(`invalid argument: ${argument}; expected --name=value`);
    return [match[1], match[2]];
  }));
}

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function concurrencyValues(value) {
  const parsed = (value || "1,8,32").split(",").map((item) => positiveInteger(item, null, "concurrency", 2_000));
  return [...new Set(parsed)].sort((left, right) => left - right);
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function latencySummary(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Number(Math.max(...values, 0).toFixed(3)),
  };
}

function directoryBytes(path) {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    bytes += entry.isDirectory() ? directoryBytes(entryPath) : statSync(entryPath).size;
  }
  return bytes;
}

function recordInput(index, tenantCount, projectCount) {
  const tenant = index % tenantCount;
  const project = `service-${index % projectCount}`;
  return {
    tenant_id: `tenant-${tenant}`,
    owner_id: `owner-${tenant}`,
    namespace_id: `project/${project}`,
    project_id: project,
    body: `Decision ${index}: ${project} uses Contract${index} through Kafka topic event-${index % 200}.`,
    title: `Contract decision ${index}`,
    symbol: `Contract${index}`,
    repo_path: `src/contracts/Contract${index}.java`,
    source_type: "verified-artifact",
    source_uri: `git://${project}/src/contracts/Contract${index}.java`,
    git_commit: index.toString(16).padStart(12, "0"),
    idempotency_key: `scale-${index}`,
  };
}

function matchingTarget(index, recordCount, tenantCount) {
  const candidate = ((index * 7_919) + 104_729) % recordCount;
  return candidate - (candidate % tenantCount);
}

function directSearchBenchmark(vault, { recordCount, queryCount, tenantCount, projectCount, warmup }) {
  const runQuery = (index) => {
    const target = matchingTarget(index, recordCount, tenantCount);
    const project = `service-${target % projectCount}`;
    return vault.search({
      query: `Contract${target}`,
      tenant_id: "tenant-0",
      owner_id: "owner-0",
      project_id: project,
      allowed_projects: [project],
      top_k: 5,
    });
  };
  for (let index = 0; index < warmup; index += 1) runQuery(index);
  const latencies = [];
  let misses = 0;
  for (let index = 0; index < queryCount; index += 1) {
    const started = performance.now();
    const results = runQuery(index);
    latencies.push(performance.now() - started);
    if (!results.some((result) => result.citation.symbol === `Contract${matchingTarget(index, recordCount, tenantCount)}`)) misses += 1;
  }
  const protectedTarget = matchingTarget(0, recordCount, tenantCount);
  const isolationResult = vault.search({
    query: `Contract${protectedTarget}`,
    tenant_id: "tenant-1",
    owner_id: "owner-1",
    project_id: `service-${protectedTarget % projectCount}`,
    allowed_projects: [`service-${protectedTarget % projectCount}`],
    top_k: 5,
  });
  return { latency_ms: latencySummary(latencies), misses, isolation_violations: isolationResult.length };
}

async function request(base, operation, index, recordCount, tenantCount, projectCount, profile) {
  const target = matchingTarget(index, recordCount, tenantCount);
  const project = `service-${target % projectCount}`;
  let path = "/v1/search";
  let kind = "search";
  let body = { query: `Contract${target}`, project_id: project, top_k: 5 };
  if (operation % 20 < 2) {
    path = "/v1/memories/captures";
    kind = "capture";
    body = {
      memory_kind: "working",
      project_id: project,
      body: `Agent observation ${profile}-${operation}-${index} for ${project} references Contract${target}.`,
      ttl_seconds: 300,
    };
  } else if (operation % 20 < 5) {
    path = "/v1/context-packs";
    kind = "context_pack";
    body = { task: `Contract${target}`, project_id: project, top_k: 8, token_budget: 1_200 };
  }
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `http-scale-${profile}-${operation}-${index}`,
    },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return { kind, status: response.status, latency: performance.now() - started };
}

async function httpProfile(base, { concurrency, operations, recordCount, tenantCount, projectCount, repetition }) {
  const latencies = { search: [], context_pack: [], capture: [] };
  const statuses = {};
  let cursor = 0;
  const started = performance.now();
  const workers = Array.from({ length: concurrency }, async (_, worker) => {
    while (true) {
      const operation = cursor;
      cursor += 1;
      if (operation >= operations) return;
      const result = await request(
        base,
        operation,
        operation + worker,
        recordCount,
        tenantCount,
        projectCount,
        `${repetition}-${concurrency}`,
      );
      latencies[result.kind].push(result.latency);
      statuses[result.status] = (statuses[result.status] || 0) + 1;
    }
  });
  await Promise.all(workers);
  const durationMs = performance.now() - started;
  const failures = Object.entries(statuses)
    .filter(([status]) => Number(status) < 200 || Number(status) >= 300)
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    concurrent_clients: concurrency,
    operations,
    workload: { search_percent: 75, context_pack_percent: 15, capture_percent: 10 },
    duration_ms: Number(durationMs.toFixed(3)),
    throughput_operations_per_second: Number((operations / (durationMs / 1000)).toFixed(2)),
    status_counts: statuses,
    failures,
    latency_ms: Object.fromEntries(Object.entries(latencies).map(([kind, values]) => [kind, latencySummary(values)])),
  };
}

async function runOnce(config, repetition) {
  const root = mkdtempSync(join(tmpdir(), `continuitydb-scale-${repetition}-`));
  const vault = new ContextVault(root);
  try {
    const ingestStarted = performance.now();
    for (let index = 0; index < config.records; index += 1) {
      const proposal = vault.propose(recordInput(index, config.tenants, config.projects));
      if (!proposal.duplicate) vault.commit(proposal.record.id);
    }
    const ingestMs = performance.now() - ingestStarted;
    const direct = directSearchBenchmark(vault, {
      recordCount: config.records,
      queryCount: config.queries,
      tenantCount: config.tenants,
      projectCount: config.projects,
      warmup: config.warmup,
    });
    const identity = {
      tenant_id: "tenant-0",
      principal_id: "scale-client",
      owner_id: "owner-0",
      agent_id: "scale-agent",
      scopes: ["memory:read", "memory:capture"],
      allowed_projects: Array.from({ length: config.projects }, (_, index) => `service-${index}`),
      allowed_sensitivities: ["private"],
    };
    const service = createContinuityServer({
      vault,
      host: "127.0.0.1",
      port: 0,
      localIdentity: identity,
      limiter: new TokenBucketLimiter({ capacity: 1_000_000_000, refillPerSecond: 1_000_000 }),
    });
    const address = await service.listen();
    const base = `http://127.0.0.1:${address.port}`;
    for (let index = 0; index < Math.min(config.warmup, 50); index += 1) {
      await request(base, 10 + (index * 20), index, config.records, config.tenants, config.projects, `warmup-${repetition}`);
    }
    const http = [];
    for (const concurrency of config.concurrency) {
      http.push(await httpProfile(base, {
        concurrency,
        operations: config.operations,
        recordCount: config.records,
        tenantCount: config.tenants,
        projectCount: config.projects,
        repetition,
      }));
    }
    const storageBytes = directoryBytes(root);
    const memory = process.memoryUsage();
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
    vault.close();
    return {
      repetition,
      corpus: { records: config.records, tenants: config.tenants, projects: config.projects },
      ingest: {
        duration_ms: Number(ingestMs.toFixed(3)),
        records_per_second: Number((config.records / (ingestMs / 1000)).toFixed(2)),
      },
      direct_search: direct,
      http,
      storage: {
        total_bytes: storageBytes,
        bytes_per_seed_record: Number((storageBytes / config.records).toFixed(2)),
      },
      process_memory: { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, external_bytes: memory.external },
    };
  } finally {
    try { vault.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

function aggregate(runs, concurrency) {
  const middle = (values) => percentile(values, 0.5);
  return {
    repetitions: runs.length,
    median_ingest_records_per_second: middle(runs.map((run) => run.ingest.records_per_second)),
    median_direct_search_p95_ms: middle(runs.map((run) => run.direct_search.latency_ms.p95)),
    worst_direct_search_p99_ms: Number(Math.max(...runs.map((run) => run.direct_search.latency_ms.p99)).toFixed(3)),
    direct_search_misses: runs.reduce((sum, run) => sum + run.direct_search.misses, 0),
    isolation_violations: runs.reduce((sum, run) => sum + run.direct_search.isolation_violations, 0),
    http: Object.fromEntries(concurrency.map((clients) => {
      const profiles = runs.map((run) => run.http.find((item) => item.concurrent_clients === clients));
      return [clients, {
        median_throughput_operations_per_second: middle(profiles.map((profile) => profile.throughput_operations_per_second)),
        median_search_p95_ms: middle(profiles.map((profile) => profile.latency_ms.search.p95)),
        median_context_pack_p95_ms: middle(profiles.map((profile) => profile.latency_ms.context_pack.p95)),
        median_capture_p95_ms: middle(profiles.map((profile) => profile.latency_ms.capture.p95)),
        failures: profiles.reduce((sum, profile) => sum + profile.failures, 0),
      }];
    })),
  };
}

const args = argumentsFrom(process.argv.slice(2));
const config = {
  records: positiveInteger(args.records, 10_000, "records", 1_000_000),
  queries: positiveInteger(args.queries, 500, "queries", 1_000_000),
  operations: positiveInteger(args.operations, 500, "operations", 1_000_000),
  repetitions: positiveInteger(args.repetitions, 3, "repetitions", 20),
  tenants: positiveInteger(args.tenants, 4, "tenants", 10_000),
  projects: positiveInteger(args.projects, 50, "projects", 10_000),
  warmup: positiveInteger(args.warmup, 50, "warmup", 10_000),
  concurrency: concurrencyValues(args.concurrency),
};
if (config.records < config.tenants) throw new Error("records must be at least the tenant count");
const machine = {
  node: process.version,
  platform: platform(),
  release: release(),
  architecture: process.arch,
  logical_cpus: cpus().length,
  cpu_model: cpus()[0]?.model || "unknown",
  total_memory_bytes: totalmem(),
};
const runs = [];
for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
  process.stderr.write(`scale benchmark repetition ${repetition}/${config.repetitions}\n`);
  runs.push(await runOnce(config, repetition));
}
const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  mode: "embedded SQLite/FTS5 mixed-workload benchmark",
  config,
  machine,
  methodology: {
    corpus: "deterministic synthetic multi-tenant Git-grounded memories",
    direct_search: "warm cache exact-symbol retrieval with tenant/project ACL filters",
    http: "75% search, 15% context pack, 10% automatic working-memory capture",
    rate_limiting: "bypassed to measure service capacity; quota behavior is tested separately",
    caveat: "concurrent HTTP clients share one embedded service identity; this is not a distributed 20k-agent proof",
  },
  runs,
  aggregate: aggregate(runs, config.concurrency),
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) {
  const destination = resolve(args.output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, serialized, "utf8");
  process.stderr.write(`wrote ${destination}\n`);
}
process.stdout.write(serialized);
if (result.aggregate.direct_search_misses || result.aggregate.isolation_violations
  || Object.values(result.aggregate.http).some((profile) => profile.failures)) process.exitCode = 2;
