import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { HybridEngine } from "../src/embeddings.js";
import { buildRepositoryGraph } from "../src/graph/repository-graph.js";
import { ContextVault, estimateSerializedTokens } from "../src/store.js";

const benchmarkDirectory = fileURLToPath(new URL(".", import.meta.url));
const fixturePath = join(benchmarkDirectory, "graph-first-fixture.json");
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes);
const packageDocument = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const COMMIT = "fixture-commit-v1";
const FIXTURE_TIMESTAMP = "2026-09-14T00:00:00.000Z";
const FIXTURE_AS_OF = "2026-09-15T00:00:00.000Z";
const MODES = ["graph-only", "graph-first", "hybrid"];
const STRUCTURAL_CLASSES = new Set([
  "exact-symbol", "call-path", "dependency-impact", "configuration-flow", "cross-project-path",
]);

const REPOSITORY_FILES = Object.freeze({
  "orders-api": {
    "pom.xml": `<project><artifactId>orders-api</artifactId><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-web</artifactId></dependency></dependencies></project>\n`,
    "src/main/java/com/acme/orders/OrderController.java": `package com.acme.orders;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.beans.factory.annotation.Value;
@RestController public class OrderController {
  private OrderService service;
  @Value("\${orders.page-size}") private int pageSize;
  @GetMapping("/orders") public void list() { service.findAll(); }
}\n`,
    "src/main/java/com/acme/orders/OrderService.java": `package com.acme.orders;
public class OrderService {
  private OrderRepository repository;
  public void findAll() { repository.findActive(); }
}\n`,
    "src/main/java/com/acme/orders/OrderRepository.java": `package com.acme.orders;
import org.springframework.beans.factory.annotation.Value;
public class OrderRepository {
  @Value("\${orders.datasource.url}") private String url;
  public void findActive() {}
}\n`,
    "src/main/java/com/acme/orders/OrderPort.java": "package com.acme.orders; public interface OrderPort {}\n",
    "src/main/java/com/acme/orders/JdbcOrderAdapter.java": "package com.acme.orders; public class JdbcOrderAdapter implements OrderPort {}\n",
    "src/main/java/com/acme/orders/PaymentBridge.java": `package com.acme.orders;
import com.acme.payments.PaymentController;
public class PaymentBridge {
  private PaymentController controller;
  public void invoke() { controller.charge(); }
}\n`,
    "src/main/resources/application.yml": "orders:\n  page-size: 25\n  datasource:\n    url: jdbc:fixture\n",
    "docs/ADR-004.md": "# Decision\nAffects `com.acme.orders.OrderService` through the transactional outbox.\n",
    "docs/ADR-009.md": "# Decision\nDocuments `orders.page-size` for stable pagination.\n",
    "README.md": "# Orders API\nProduction extraction benchmark fixture.\n",
  },
  "orders-schema": {
    "pom.xml": `<project><artifactId>orders-schema</artifactId><dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency></dependencies></project>\n`,
    "src/main/java/com/acme/events/OrderCreated.java": "package com.acme.events; public class OrderCreated { public String orderId; }\n",
    "src/main/java/com/acme/events/OrderCancelled.java": "package com.acme.events; public class OrderCancelled { public String reason; }\n",
    "src/main/resources/application.yml": "events:\n  orders:\n    topic: orders\n",
    "docs/ADR-012.md": "# Decision\nDocuments `com.acme.events.OrderCreated` compatibility.\n",
  },
  payments: {
    "build.gradle.kts": `rootProject.name = "payments"\ndependencies { implementation("com.stripe:stripe-java:24.0.0") }\n`,
    "src/main/java/com/acme/payments/PaymentController.java": `package com.acme.payments;
import org.springframework.web.bind.annotation.PostMapping;
public class PaymentController {
  private PaymentService service;
  @PostMapping("/payments") public void charge() { service.charge(); }
}\n`,
    "src/main/java/com/acme/payments/PaymentService.java": `package com.acme.payments;
import org.springframework.beans.factory.annotation.Value;
public class PaymentService {
  private StripeGateway gateway;
  @Value("\${payment.timeout-ms}") private int timeout;
  public void charge() { gateway.authorize(); }
}\n`,
    "src/main/java/com/acme/payments/StripeGateway.java": "package com.acme.payments; public class StripeGateway { public void authorize() {} }\n",
    "src/main/resources/application.yml": "payment:\n  timeout-ms: 1000\n",
    "docs/ADR-021.md": "# Decision\nDocuments `com.acme.payments.StripeGateway` as the provider abstraction.\n",
  },
  "payroll-private": {
    "src/main/java/corp/payroll/SecretPayrollExporter.java": `package corp.payroll;
import org.springframework.beans.factory.annotation.Value;
public class SecretPayrollExporter {
  @Value("\${payroll.ssn-key}") private String key;
  public void export() {}
}\n`,
    "src/main/resources/application.yml": "payroll:\n  ssn-key: fixture-reference\n",
  },
  "admin-private": {
    "src/main/java/corp/admin/RootAdminController.java": "package corp.admin; public class RootAdminController { public void disableAudit() {} }\n",
  },
});

function git(repo, args, date = null) {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createCommittedRepository(parent, projectId, files, date = FIXTURE_TIMESTAMP) {
  const repo = join(parent, projectId);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Benchmark Fixture"]);
  git(repo, ["config", "user.email", "benchmark@example.invalid"]);
  for (const [repoPath, contents] of Object.entries(files)) {
    const target = join(repo, repoPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial production benchmark fixture"], date);
  return repo;
}

const MEMORY_CORPUS = [
  ["memory:outbox", "orders-api", "Duplicate publication recovery", "Prevent duplicate publication after a database commit by persisting a relay item atomically and making consumers idempotent. The relay retries delivery without coupling the database transaction to the broker. Operational ownership includes backlog alarms, poison-message quarantine, and replay procedures."],
  ["memory:retention", "orders-api", "Customer retention ownership", "The privacy platform team owns customer data retention and deletion scheduling. Product services publish deletion eligibility while the privacy scheduler records completion evidence and retries incomplete erasure work."],
  ["memory:feature-flags", "payments", "Risk-limited rollout", "Risky payment rollouts use a server-side feature flag, a one-percent canary, provider error budgets, and an automatic rollback threshold. The flag must be independently reversible from application deployment."],
  ["memory:compatibility", "orders-schema", "Compatible event evolution", "Old API clients remain compatible during event changes through additive fields, tolerant readers, a two-release deprecation window, and consumer contract tests before any field removal."],
  ["memory:outbox-decision", "orders-api", "Transactional outbox decision", "The transactional outbox was chosen because order state and publication intent need one atomic commit. Direct dual writes were rejected after a broker outage demonstrated an unrecoverable consistency gap."],
  ["memory:retention-decision", "orders-api", "Audit retention decision", "The audit retention decision keeps immutable operational events for thirteen months, then deletes them through a separately reviewed retention job. Legal holds pause expiry without changing event contents."],
  ["memory:gateway-decision", "payments", "Provider abstraction decision", "A payment provider abstraction was selected so provider credentials, retry semantics, and error mapping remain isolated behind one adapter. Domain services depend on the port rather than a vendor SDK."],
  ["memory:pagination-decision", "orders-api", "Pagination limits decision", "The pagination decision caps page size at one hundred and defaults it to twenty-five. Stable cursor ordering was selected to avoid duplicates during concurrent order creation."],
  ["memory:payroll-secret", "payroll-private", "Payroll SSN export procedure", "The payroll SSN export procedure uses the payroll.ssn-key and SecretPayrollExporter. It is restricted to the payroll-private project and must not be disclosed outside that scope."],
];

class DeterministicBenchmarkEmbedder {
  constructor() {
    this.id = "benchmark-deterministic-v1";
    this.queryCalls = 0;
  }

  vector(text) {
    const value = String(text).toLowerCase();
    const tests = [
      /duplicate publication|database commit|relay item/,
      /customer data retention|deletion scheduling|privacy platform/,
      /risky payment rollouts|one-percent canary|feature flag/,
      /old api clients|compatible during event|tolerant readers/,
      /transactional outbox|dual writes|publication intent/,
      /audit retention|thirteen months|legal holds/,
      /payment provider abstraction|vendor sdk|provider credentials/,
      /pagination limits|page size|cursor ordering/,
    ];
    const vector = Array(64).fill(0);
    tests.forEach((pattern, index) => { if (pattern.test(value)) vector[index] = 4; });
    const tokens = value.match(/[a-z0-9][a-z0-9-]{1,40}/g) || [];
    for (const token of tokens) {
      const digest = createHash("sha256").update(token).digest();
      const index = 8 + (digest[0] % 56);
      vector[index] += (digest[1] & 1) ? 1 : -1;
    }
    const fingerprint = createHash("sha512").update(value).digest();
    for (let index = 8; index < vector.length; index += 1) {
      vector[index] += ((fingerprint[index - 8] / 255) - 0.5) * 0.01;
    }
    return vector;
  }

  async embed(texts) {
    return (Array.isArray(texts) ? texts : [texts]).map((text) => this.vector(text));
  }

  async embedQuery(text) {
    this.queryCalls += 1;
    return this.vector(text);
  }

  async embedDocuments(texts) {
    return texts.map((text) => this.vector(text));
  }
}

async function seedVault(vault, engine, repositoryRoot) {
  const repositories = new Map(Object.entries(REPOSITORY_FILES).map(([projectId, files]) => [
    projectId, createCommittedRepository(repositoryRoot, projectId, files),
  ]));
  const initialBuilds = new Map();
  // Dependencies are extracted first so the orders build can resolve its
  // PaymentBridge call to an endpoint in another active graph generation.
  for (const projectId of ["payments", "orders-schema", "payroll-private", "admin-private", "orders-api"]) {
    initialBuilds.set(projectId, buildRepositoryGraph(vault, repositories.get(projectId), {
      projectId,
      ownerId: projectId === "admin-private" ? "other-owner" : "local-user",
      sensitivity: projectId === "payroll-private" ? "restricted" : "private",
    }));
  }
  vault.linkProjects({ source_project: "orders-api", target_project: "orders-schema", provenance: "benchmark fixture" });
  vault.linkProjects({ source_project: "orders-api", target_project: "payments", provenance: "benchmark fixture" });

  const memoryIds = new Map();
  for (const [fixtureId, projectId, title, body] of MEMORY_CORPUS) {
    const proposed = vault.propose({
      tenant_id: "local", owner_id: "local-user", project_id: projectId,
      namespace_id: `project/${projectId}`, type: "decision", title, body,
      sensitivity: "private", source_type: "verified-artifact",
      source_uri: `git://${projectId}/docs/decisions.md`, repo_path: "docs/decisions.md",
      git_commit: COMMIT, branch: "main", idempotency_key: `benchmark-${fixtureId}`,
    });
    const memoryId = stabilizeFixtureMemoryId(vault, proposed.record, fixtureId);
    vault.commit(memoryId);
    vault.db.prepare(`
      UPDATE memory_records SET created_at = ?, updated_at = ?, observed_at = ? WHERE id = ?
    `).run(FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP, memoryId);
    memoryIds.set(fixtureId, memoryId);
  }
  await Promise.all([...memoryIds.values()].map((id) => engine.indexMemory(id)));

  const ordersRepo = repositories.get("orders-api");
  writeFileSync(join(ordersRepo, "README.md"), "# Orders API\nIncremental production extraction benchmark fixture.\n", "utf8");
  git(ordersRepo, ["add", "README.md"]);
  git(ordersRepo, ["commit", "-m", "incremental documentation update"], "2026-09-14T00:01:00.000Z");
  const incrementalStarted = performance.now();
  const incremental = buildRepositoryGraph(vault, ordersRepo, { projectId: "orders-api" });
  const incrementalUpdateTimeMs = performance.now() - incrementalStarted;

  const knownNodeIds = new Set();
  const nodeProjects = new Map();
  for (const row of vault.db.prepare("SELECT id, project_id FROM graph_nodes ORDER BY id").all()) {
    knownNodeIds.add(row.id);
    nodeProjects.set(row.id, row.project_id);
  }
  const knownEdgeKeys = new Set(vault.db.prepare(`
    SELECT relation, source_id, target_id FROM graph_edges ORDER BY id
  `).all().map((edge) => `${edge.relation}\0${edge.source_id}\0${edge.target_id}`));
  const validCommits = new Set([
    COMMIT,
    ...vault.db.prepare("SELECT DISTINCT \"commit\" FROM graph_generations").all().map((row) => row.commit),
  ]);
  return {
    knownNodeIds,
    knownEdgeKeys,
    memoryIds,
    nodeProjects,
    repositories,
    initialBuilds,
    incremental,
    incrementalUpdateTimeMs,
    validCommits,
  };
}

// ContextVault correctly creates production IDs randomly. The benchmark needs
// deterministic tie-breaking, so it replaces only its disposable fixture IDs
// before those records become active or acquire dependent rows.
function stabilizeFixtureMemoryId(vault, record, fixtureId) {
  const memoryId = `benchmark-${fixtureId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const stableRecord = { ...record, id: memoryId };
  vault.runTransaction(() => {
    vault.db.prepare("UPDATE memory_records SET id = ? WHERE id = ?").run(memoryId, record.id);
    vault.db.prepare("UPDATE audit_events SET target_id = ? WHERE target_id = ?").run(memoryId, record.id);
    const events = vault.db.prepare(`
      SELECT event_id, timestamp, actor, operation, target_id, result
      FROM audit_events ORDER BY sequence
    `).all();
    let previousHash = null;
    const update = vault.db.prepare("UPDATE audit_events SET previous_hash = ?, event_hash = ? WHERE event_id = ?");
    for (const event of events) {
      const base = { ...event, previous_hash: previousHash };
      const eventHash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
      update.run(previousHash, eventHash, event.event_id);
      previousHash = eventHash;
    }
  });
  vault.writeCanonical(stableRecord);
  rmSync(vault.recordPath(record.id), { force: true });
  return memoryId;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function rounded(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function generationProjects(retrieval) {
  const generation = retrieval?.graph_generation;
  if (!generation) return [];
  if (Array.isArray(generation.generations)) return generation.generations.map((item) => item.project_id);
  return generation.project_id ? [generation.project_id] : [];
}

function generationCommits(retrieval) {
  const generation = retrieval?.graph_generation;
  if (!generation) return [];
  if (Array.isArray(generation.generations)) return generation.generations.map((item) => item.commit);
  return generation.commit ? [generation.commit] : [];
}

function canonicalContextTokens(pack) {
  const canonical = structuredClone(pack);
  if (canonical.generated_at) canonical.generated_at = "2026-09-14T00:00:00.000Z";
  if (canonical.budget) {
    canonical.budget.estimated_tokens = 0;
    canonical.budget.serialized_bytes = 0;
  }
  for (const result of canonical.memories || []) {
    if (result.score !== undefined) result.score = 0;
    if (result.temporal?.observed_at) result.temporal.observed_at = "2026-09-14T00:00:00.000Z";
  }
  return estimateSerializedTokens(canonical);
}

function graphPathEndpointIds(results) {
  return [...new Set(results.flatMap((result) => (result.graph_path || []).flatMap((edge) => [
    edge.source_id,
    edge.target_id,
  ]).filter(Boolean)))].sort();
}

export function observeBenchmarkQuery(
  query,
  mode,
  pack,
  durationMs,
  embeddingInvocations,
  memoryIds,
  nodeProjects = new Map(),
  validCommits = new Set([COMMIT]),
) {
  const results = pack.memories || [];
  const gold = new Set([
    ...query.gold_node_ids,
    ...query.gold_memory_ids.map((id) => memoryIds.get(id)).filter(Boolean),
  ]);
  const returned = new Set(results.map((result) => result.id));
  const goldHits = [...gold].filter((id) => returned.has(id)).length;
  const citedEdges = new Set(results.flatMap((result) => (result.graph_path || []).map(
    (edge) => `${edge.relation}\0${edge.source_id}\0${edge.target_id}`,
  )));
  const requiredPathHits = query.required_citation_edges.filter((edge) => (
    citedEdges.has(`${edge.relation}\0${edge.source_id}\0${edge.target_id}`)
  )).length;
  const forbidden = new Set(query.forbidden_projects);
  const authorized = new Set(query.authorized_projects);
  const pathEndpointIds = graphPathEndpointIds(results);
  const unmappedPathEndpointIds = pathEndpointIds.filter((nodeId) => !nodeProjects.has(nodeId));
  const pathEndpointProjects = pathEndpointIds.map((nodeId) => nodeProjects.get(nodeId)).filter(Boolean);
  const disclosedProjects = [
    ...results.map((result) => result.project_id),
    ...generationProjects(pack.retrieval),
    ...pathEndpointProjects,
  ].filter(Boolean);
  const disclosedProjectSet = [...new Set(disclosedProjects)].sort();
  const forbiddenEvidenceProjects = disclosedProjectSet.filter((projectId) => forbidden.has(projectId));
  const unauthorizedEvidenceProjects = disclosedProjectSet.filter((projectId) => !authorized.has(projectId));
  const crossScopeFailure = forbiddenEvidenceProjects.length > 0
    || unauthorizedEvidenceProjects.length > 0
    || unmappedPathEndpointIds.length > 0;
  const staleReasons = [
    ...results.flatMap((result) => {
      const reasons = [];
      if (result.temporal?.stale === true) reasons.push(`${result.id}:stale`);
      if (result.citation?.git_commit && !validCommits.has(result.citation.git_commit)) reasons.push(`${result.id}:citation-commit`);
      if ((result.graph_path || []).some((edge) => edge.commit && !validCommits.has(edge.commit))) reasons.push(`${result.id}:path-commit`);
      return reasons;
    }),
    ...generationCommits(pack.retrieval)
      .filter((commit) => commit && !validCommits.has(commit))
      .map((commit) => `generation:${commit}`),
  ];
  const staleEvidence = staleReasons.length > 0;
  const staleness = staleEvidence ? 1 : 0;
  return {
    id: query.id,
    class: query.class,
    mode,
    gold_hits: goldHits,
    gold_total: gold.size,
    required_path_hits: requiredPathHits,
    required_path_total: query.required_citation_edges.length,
    latency_ms: durationMs,
    context_tokens: canonicalContextTokens(pack),
    embedding_invocations: embeddingInvocations,
    result_count: results.length,
    expected_empty_failure: query.expected_empty === true && results.length !== 0,
    cross_scope_failure: crossScopeFailure,
    disclosed_projects: disclosedProjectSet,
    forbidden_evidence_projects: forbiddenEvidenceProjects,
    unmapped_path_endpoint_ids: unmappedPathEndpointIds,
    stale_generation_failure: staleness > query.maximum_acceptable_staleness,
    stale_reasons: staleReasons,
    fallback_reason: pack.retrieval?.fallback_reason || null,
    effective_mode: pack.retrieval?.effective_mode || pack.retrieval_mode || mode,
  };
}

export function summarizeBenchmarkObservations(observations) {
  const queries = observations.length;
  const goldHits = observations.reduce((sum, item) => sum + item.gold_hits, 0);
  const goldTotal = observations.reduce((sum, item) => sum + item.gold_total, 0);
  const pathHits = observations.reduce((sum, item) => sum + item.required_path_hits, 0);
  const pathTotal = observations.reduce((sum, item) => sum + item.required_path_total, 0);
  const embeddingInvocations = observations.reduce((sum, item) => sum + item.embedding_invocations, 0);
  const structural = observations.filter((item) => STRUCTURAL_CLASSES.has(item.class));
  const contextTokens = observations.map((item) => item.context_tokens);
  const latencies = observations.map((item) => item.latency_ms);
  const avoidanceRate = (items) => (items.length
    ? rounded(items.filter((item) => item.embedding_invocations === 0).length / items.length)
    : null);
  return {
    queries,
    recall_at_5: goldTotal ? rounded(goldHits / goldTotal) : 1,
    answer_accuracy: null,
    required_path_coverage: pathTotal ? rounded(pathHits / pathTotal) : 1,
    p50_latency_ms: rounded(percentile(latencies, 0.5)),
    p95_latency_ms: rounded(percentile(latencies, 0.95)),
    median_context_tokens: rounded(percentile(contextTokens, 0.5), 0),
    p95_context_tokens: rounded(percentile(contextTokens, 0.95), 0),
    embedding_invocations: embeddingInvocations,
    // Avoidance measures requests that bypass query embedding. Counting raw calls
    // would understate avoidance if an embedder retries or batches internally.
    embedding_avoidance_rate: avoidanceRate(observations),
    structural_embedding_avoidance_rate: avoidanceRate(structural),
    stale_generation_failures: observations.filter((item) => item.stale_generation_failure).length,
    cross_scope_failures: observations.filter((item) => item.cross_scope_failure).length,
    expected_empty_failures: observations.filter((item) => item.expected_empty_failure).length,
  };
}

function validateFixture(knownNodeIds, knownEdgeKeys, memoryIds) {
  if (fixture.version !== 1 || fixture.queries.length !== 30) throw new Error("graph-first fixture version/count changed");
  if (new Set(fixture.queries.map((query) => query.id)).size !== fixture.queries.length) throw new Error("duplicate fixture query ID");
  if (fixture.queries.filter((query) => query.forbidden_projects.length).length < 5) throw new Error("fixture needs five isolation queries");
  for (const query of fixture.queries) {
    if (!query.expected_empty && !query.gold_node_ids.length && !query.gold_memory_ids.length) {
      throw new Error(`${query.id} needs a gold node or memory`);
    }
    if (query.expected_empty && (!query.isolation_probe
      || !Array.isArray(query.denied_identifiers)
      || !query.denied_identifiers.some((identifier) => query.question.includes(identifier)))) {
      throw new Error(`${query.id} is not an active denied-scope isolation probe`);
    }
    if (!query.gold_node_ids.every((id) => knownNodeIds.has(id))) throw new Error(`${query.id} names an unknown gold node`);
    if (!query.gold_memory_ids.every((id) => memoryIds.has(id))) throw new Error(`${query.id} names an unknown gold memory`);
    if (!query.required_citation_edges.every((edge) => edge && knownEdgeKeys.has(
      `${edge.relation}\0${edge.source_id}\0${edge.target_id}`,
    ))) throw new Error(`${query.id} names an invalid required citation edge`);
  }
}

function runSecurityProbes(vault, seed) {
  const common = {
    tenant_id: "local",
    retrieval_mode: "graph-only",
    top_k: 5,
    token_budget: 1200,
  };
  const ownerScopeFailures = vault.searchDetailed({
    ...common,
    owner_id: "local-user",
    project_id: "admin-private",
    allowed_projects: ["admin-private"],
    allowed_sensitivities: ["private"],
    branch: "main",
    query: "corp.admin.RootAdminController.disableAudit",
  }).results.length;
  const sensitivityScopeFailures = vault.searchDetailed({
    ...common,
    owner_id: "local-user",
    project_id: "payroll-private",
    allowed_projects: ["payroll-private"],
    allowed_sensitivities: ["private"],
    branch: "main",
    query: "corp.payroll.SecretPayrollExporter",
  }).results.length;
  const omittedBranchFailures = vault.searchDetailed({
    ...common,
    owner_id: "local-user",
    project_id: "orders-api",
    allowed_projects: ["orders-api"],
    allowed_sensitivities: ["private"],
    query: "com.acme.orders.OrderService.findAll",
  }).results.length;
  const historical = vault.searchDetailed({
    ...common,
    owner_id: "local-user",
    project_id: "orders-api",
    allowed_projects: ["orders-api"],
    allowed_sensitivities: ["private"],
    branch: "main",
    as_of: "2026-09-14T00:00:30.000Z",
    query: "com.acme.orders.OrderService.findAll",
  });
  const historicalGenerationFailures = historical.retrieval.graph_generation?.commit
    === seed.initialBuilds.get("orders-api").commit ? 0 : 1;
  const crossGeneration = vault.searchDetailed({
    ...common,
    owner_id: "local-user",
    project_id: "orders-api",
    allowed_projects: ["orders-api", "payments"],
    allowed_sensitivities: ["private"],
    branch: "main",
    direction: "outgoing",
    query: "com.acme.orders.PaymentBridge.invoke",
  });
  const productionCrossGenerationFailures = crossGeneration.results.some((result) => (
    result.graph_path.some((edge) => edge.target_label === "com.acme.payments.PaymentController.charge"
      && edge.source_generation_id !== edge.target_generation_id)
  )) ? 0 : 1;
  return {
    owner_scope_failures: ownerScopeFailures,
    sensitivity_scope_failures: sensitivityScopeFailures,
    omitted_branch_failures: omittedBranchFailures,
    historical_generation_failures: historicalGenerationFailures,
    production_cross_generation_failures: productionCrossGenerationFailures,
  };
}

export async function runGraphFirstBenchmark({ promotionRequested = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-first-benchmark-"));
  const vault = new ContextVault(root);
  const embedder = new DeterministicBenchmarkEmbedder();
  const engine = new HybridEngine(vault, embedder);
  try {
    const repositoryRoot = join(root, "benchmark-repositories");
    mkdirSync(repositoryRoot, { recursive: true });
    let peakMemoryBytes = process.memoryUsage().rss;
    const indexStarted = performance.now();
    const seed = await seedVault(vault, engine, repositoryRoot);
    const indexWallTimeMs = performance.now() - indexStarted;
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    const { knownNodeIds, knownEdgeKeys, memoryIds, nodeProjects, validCommits } = seed;
    validateFixture(knownNodeIds, knownEdgeKeys, memoryIds);
    const securityProbes = runSecurityProbes(vault, seed);
    embedder.queryCalls = 0;
    const observations = [];
    for (const mode of MODES) {
      for (const query of fixture.queries) {
        const callsBefore = embedder.queryCalls;
        const started = performance.now();
        const pack = await engine.contextPack({
          task: query.question,
          project_id: query.project_id,
          tenant_id: "local",
          owner_id: "local-user",
          allowed_projects: query.authorized_projects,
          allowed_sensitivities: ["private"],
          branch: query.branch,
          as_of: FIXTURE_AS_OF,
          retrieval_mode: mode,
          graph_depth: 2,
          graph_max_visited: 400,
          graph_max_paths: 40,
          strict_evidence: true,
          exclude_types: query.expected_empty ? ["decision"] : [],
          top_k: fixture.top_k,
          token_budget: fixture.token_budget,
        });
        observations.push(observeBenchmarkQuery(
          query, mode, pack, performance.now() - started,
          embedder.queryCalls - callsBefore, memoryIds, nodeProjects, validCommits,
        ));
        peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
      }
    }

    const modes = Object.fromEntries(MODES.map((mode) => [
      mode, summarizeBenchmarkObservations(observations.filter((item) => item.mode === mode)),
    ]));
    const classes = [...new Set(fixture.queries.map((query) => query.class))].sort();
    const byQueryClass = Object.fromEntries(classes.map((queryClass) => [queryClass,
      Object.fromEntries(MODES.map((mode) => [mode, summarizeBenchmarkObservations(observations.filter(
        (item) => item.mode === mode && item.class === queryClass,
      ))])),
    ]));
    const crossScopeFailures = observations.filter((item) => item.cross_scope_failure).length;
    const staleGenerationFailures = observations.filter((item) => item.stale_generation_failure).length;
    const expectedEmptyFailures = observations.filter((item) => item.expected_empty_failure).length;
    vault.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const databaseSizeBytes = statSync(join(root, "index", "context-vault.db")).size;
    const tokenReduction = 1 - modes["graph-first"].median_context_tokens / modes.hybrid.median_context_tokens;
    const gates = {
      no_answer_accuracy_regression: false,
      median_context_token_reduction_at_least_20_percent: tokenReduction >= 0.2,
      exact_structural_embedding_avoidance_at_least_60_percent:
        modes["graph-first"].structural_embedding_avoidance_rate >= 0.6,
      zero_cross_scope_failures: crossScopeFailures === 0,
      zero_stale_generation_failures: staleGenerationFailures === 0,
      zero_expected_empty_failures: expectedEmptyFailures === 0,
      production_security_probes_passed: Object.values(securityProbes).every((value) => value === 0),
    };
    const releaseGatesPassed = Object.values(gates).every(Boolean);
    return {
      benchmark: "continuitydb-native-graph-first-ablation",
      benchmark_version: 1,
      fixture: {
        version: fixture.version,
        sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
        queries: fixture.queries.length,
        isolation_queries: fixture.queries.filter((query) => query.forbidden_projects.length).length,
        top_k: fixture.top_k,
        token_budget: fixture.token_budget,
      },
      environment: {
        continuitydb: packageDocument.version,
        node: process.version,
        sqlite: process.versions.sqlite || null,
        platform: process.platform,
        architecture: process.arch,
        embedding_provider: embedder.id,
        external_services: false,
      },
      methodology: {
        vaults: 1,
        graph_generations: Number(vault.db.prepare("SELECT count(*) AS count FROM graph_generations").get().count),
        records: MEMORY_CORPUS.length,
        modes: MODES,
        graph_source: "production-committed-snapshot-extraction",
        production_repositories: REPOSITORY_FILES ? Object.keys(REPOSITORY_FILES).length : 0,
        graph_builder: "buildRepositoryGraph",
        latency_clock: "performance.now",
        context_token_estimator: "ContinuityDB estimateSerializedTokens with volatile timestamps, scores, and self-measurement fields canonicalized",
      },
      modes,
      by_query_class: byQueryClass,
      security: {
        cross_scope_failures: crossScopeFailures,
        stale_generation_failures: staleGenerationFailures,
        expected_empty_failures: expectedEmptyFailures,
        ...securityProbes,
      },
      resources: {
        index_wall_time_ms: rounded(indexWallTimeMs),
        incremental_update_time_ms: rounded(seed.incrementalUpdateTimeMs),
        peak_memory_bytes: peakMemoryBytes,
        database_size_bytes: databaseSizeBytes,
        incremental_parsed_files: seed.incremental.parsed_files,
        incremental_reused_files: seed.incremental.reused_files,
      },
      release_gates: {
        ...gates,
        answer_accuracy_evaluated: false,
        answer_accuracy_note: "No downstream answer model is invoked; recall_at_5 is reported separately and is not treated as answer accuracy.",
        retrieval_recall_no_regression: modes["graph-first"].recall_at_5 >= modes.hybrid.recall_at_5,
        measured_median_context_token_reduction: rounded(tokenReduction),
        passed: releaseGatesPassed,
      },
      promotion_request: promotionRequested ? "graph-first" : null,
      recommended_default: releaseGatesPassed ? "graph-first" : "hybrid",
      query_results: observations.map((item) => ({ ...item, latency_ms: rounded(item.latency_ms) })),
    };
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const promotionRequested = process.argv.includes("--promote-default=graph-first");
  const report = await runGraphFirstBenchmark({ promotionRequested });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
  if (outputArgument) writeFileSync(resolve(outputArgument.slice("--output=".length)), json, "utf8");
  process.stdout.write(json);
  if (Object.values(report.security).some((value) => Number(value) > 0)) process.exitCode = 2;
  if (promotionRequested && !report.release_gates.passed) process.exitCode = 3;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
