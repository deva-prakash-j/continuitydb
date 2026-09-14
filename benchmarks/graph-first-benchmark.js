import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { HybridEngine } from "../src/embeddings.js";
import { graphNodeId } from "../src/graph/model.js";
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

function graphNode(projectId, repoPath, kind, qualifiedName, label = null) {
  return {
    repo_path: repoPath,
    kind,
    qualified_name: qualifiedName,
    label: label || qualifiedName.split(/[.#]/).at(-1),
    language: repoPath.endsWith(".java") ? "java" : repoPath.endsWith(".md") ? "markdown" : "structured",
    provenance: "extracted",
  };
}

function projection(projectId, nodes, edgeDefinitions) {
  const byName = new Map(nodes.map((node) => [node.qualified_name, node]));
  const edges = edgeDefinitions.map(([source, target, relation, repoPath, startLine]) => ({
    source: byName.get(source), target: byName.get(target), relation,
    repo_path: repoPath, start_line: startLine, provenance: "extracted",
  }));
  if (edges.some((edge) => !edge.source || !edge.target)) throw new Error(`invalid ${projectId} benchmark edge`);
  const sourcePaths = [...new Set(nodes.map((node) => node.repo_path))].sort();
  return {
    tenant_id: "local",
    project_id: projectId,
    branch: "main",
    commit: COMMIT,
    extractor_version: "benchmark-v1",
    source_states: sourcePaths.map((repo_path) => ({
      repo_path,
      git_object_id: createHash("sha256").update(`${projectId}\0${repo_path}`).digest("hex"),
    })),
    nodes,
    edges,
  };
}

function graphCorpus() {
  const orders = [
    graphNode("orders-api", "pom.xml", "module", "orders-api", "orders-api"),
    graphNode("orders-api", "pom.xml", "dependency", "org.springframework:spring-web", "spring-web"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderController.java", "class", "com.acme.orders.OrderController", "OrderController"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderController.java", "method", "com.acme.orders.OrderController.list", "list"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderController.java", "endpoint", "GET /orders", "GET /orders"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderService.java", "class", "com.acme.orders.OrderService", "OrderService"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderService.java", "method", "com.acme.orders.OrderService.findAll", "findAll"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderRepository.java", "class", "com.acme.orders.OrderRepository", "OrderRepository"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderRepository.java", "method", "com.acme.orders.OrderRepository.findActive", "findActive"),
    graphNode("orders-api", "src/main/resources/application.yml", "configuration-key", "orders.page-size", "orders.page-size"),
    graphNode("orders-api", "src/main/resources/application.yml", "configuration-key", "orders.datasource.url", "orders.datasource.url"),
    graphNode("orders-api", "docs/ADR-004.md", "decision", "ADR-004#Decision", "Transactional outbox decision"),
    graphNode("orders-api", "docs/ADR-009.md", "decision", "ADR-009#Decision", "Pagination decision"),
    graphNode("orders-api", "src/main/java/com/acme/orders/OrderPort.java", "interface", "com.acme.orders.OrderPort", "OrderPort"),
    graphNode("orders-api", "src/main/java/com/acme/orders/JdbcOrderAdapter.java", "class", "com.acme.orders.JdbcOrderAdapter", "JdbcOrderAdapter"),
  ];
  const schema = [
    graphNode("orders-schema", "pom.xml", "module", "orders-schema", "orders-schema"),
    graphNode("orders-schema", "pom.xml", "dependency", "com.fasterxml.jackson.core:jackson-databind", "jackson-databind"),
    graphNode("orders-schema", "src/main/java/com/acme/events/OrderCreated.java", "class", "com.acme.events.OrderCreated", "OrderCreated"),
    graphNode("orders-schema", "src/main/java/com/acme/events/OrderCreated.java", "field", "com.acme.events.OrderCreated.orderId", "orderId"),
    graphNode("orders-schema", "src/main/java/com/acme/events/OrderCancelled.java", "class", "com.acme.events.OrderCancelled", "OrderCancelled"),
    graphNode("orders-schema", "src/main/java/com/acme/events/OrderCancelled.java", "field", "com.acme.events.OrderCancelled.reason", "reason"),
    graphNode("orders-schema", "src/main/resources/application.yml", "configuration-key", "events.orders.topic", "events.orders.topic"),
    graphNode("orders-schema", "docs/ADR-012.md", "decision", "ADR-012#Decision", "Compatibility decision"),
  ];
  const payments = [
    graphNode("payments", "build.gradle.kts", "module", "payments", "payments"),
    graphNode("payments", "build.gradle.kts", "dependency", "com.stripe:stripe-java", "stripe-java"),
    graphNode("payments", "src/main/java/com/acme/payments/PaymentController.java", "class", "com.acme.payments.PaymentController", "PaymentController"),
    graphNode("payments", "src/main/java/com/acme/payments/PaymentController.java", "method", "com.acme.payments.PaymentController.charge", "charge"),
    graphNode("payments", "src/main/java/com/acme/payments/PaymentController.java", "endpoint", "POST /payments", "POST /payments"),
    graphNode("payments", "src/main/java/com/acme/payments/PaymentService.java", "class", "com.acme.payments.PaymentService", "PaymentService"),
    graphNode("payments", "src/main/java/com/acme/payments/PaymentService.java", "method", "com.acme.payments.PaymentService.charge", "charge"),
    graphNode("payments", "src/main/java/com/acme/payments/StripeGateway.java", "class", "com.acme.payments.StripeGateway", "StripeGateway"),
    graphNode("payments", "src/main/java/com/acme/payments/StripeGateway.java", "method", "com.acme.payments.StripeGateway.authorize", "authorize"),
    graphNode("payments", "src/main/resources/application.yml", "configuration-key", "payment.timeout-ms", "payment.timeout-ms"),
    graphNode("payments", "docs/ADR-021.md", "decision", "ADR-021#Decision", "Provider abstraction decision"),
  ];
  const payroll = [
    graphNode("payroll-private", "src/main/java/corp/payroll/SecretPayrollExporter.java", "class", "corp.payroll.SecretPayrollExporter", "SecretPayrollExporter"),
    graphNode("payroll-private", "src/main/java/corp/payroll/SecretPayrollExporter.java", "method", "corp.payroll.SecretPayrollExporter.export", "export"),
    graphNode("payroll-private", "src/main/resources/application.yml", "configuration-key", "payroll.ssn-key", "payroll.ssn-key"),
  ];
  const admin = [
    graphNode("admin-private", "src/main/java/corp/admin/RootAdminController.java", "class", "corp.admin.RootAdminController", "RootAdminController"),
    graphNode("admin-private", "src/main/java/corp/admin/RootAdminController.java", "method", "corp.admin.RootAdminController.disableAudit", "disableAudit"),
  ];
  return [
    projection("orders-api", orders, [
      ["orders-api", "org.springframework:spring-web", "depends-on", "pom.xml", 10],
      ["com.acme.orders.OrderController", "com.acme.orders.OrderController.list", "contains", "src/main/java/com/acme/orders/OrderController.java", 8],
      ["com.acme.orders.OrderController.list", "com.acme.orders.OrderService.findAll", "calls", "src/main/java/com/acme/orders/OrderController.java", 21],
      ["com.acme.orders.OrderController.list", "GET /orders", "exposes", "src/main/java/com/acme/orders/OrderController.java", 19],
      ["com.acme.orders.OrderController", "orders.page-size", "reads-config", "src/main/java/com/acme/orders/OrderController.java", 12],
      ["com.acme.orders.OrderService", "com.acme.orders.OrderService.findAll", "contains", "src/main/java/com/acme/orders/OrderService.java", 7],
      ["com.acme.orders.OrderService.findAll", "com.acme.orders.OrderRepository.findActive", "calls", "src/main/java/com/acme/orders/OrderService.java", 18],
      ["com.acme.orders.OrderRepository", "com.acme.orders.OrderRepository.findActive", "contains", "src/main/java/com/acme/orders/OrderRepository.java", 7],
      ["com.acme.orders.OrderRepository", "orders.datasource.url", "reads-config", "src/main/java/com/acme/orders/OrderRepository.java", 11],
      ["com.acme.orders.JdbcOrderAdapter", "com.acme.orders.OrderPort", "implements", "src/main/java/com/acme/orders/JdbcOrderAdapter.java", 6],
      ["ADR-004#Decision", "com.acme.orders.OrderService", "affects", "docs/ADR-004.md", 9],
      ["ADR-009#Decision", "orders.page-size", "documents", "docs/ADR-009.md", 7]
    ]),
    projection("orders-schema", schema, [
      ["orders-schema", "com.fasterxml.jackson.core:jackson-databind", "depends-on", "pom.xml", 11],
      ["com.acme.events.OrderCreated", "com.acme.events.OrderCreated.orderId", "declares", "src/main/java/com/acme/events/OrderCreated.java", 6],
      ["com.acme.events.OrderCancelled", "com.acme.events.OrderCancelled.reason", "declares", "src/main/java/com/acme/events/OrderCancelled.java", 6],
      ["orders-schema", "events.orders.topic", "reads-config", "src/main/resources/application.yml", 2],
      ["ADR-012#Decision", "com.acme.events.OrderCreated", "documents", "docs/ADR-012.md", 8]
    ]),
    projection("payments", payments, [
      ["payments", "com.stripe:stripe-java", "depends-on", "build.gradle.kts", 13],
      ["com.acme.payments.PaymentController", "com.acme.payments.PaymentController.charge", "contains", "src/main/java/com/acme/payments/PaymentController.java", 8],
      ["com.acme.payments.PaymentController.charge", "com.acme.payments.PaymentService.charge", "calls", "src/main/java/com/acme/payments/PaymentController.java", 20],
      ["com.acme.payments.PaymentController.charge", "POST /payments", "exposes", "src/main/java/com/acme/payments/PaymentController.java", 18],
      ["com.acme.payments.PaymentService", "com.acme.payments.PaymentService.charge", "contains", "src/main/java/com/acme/payments/PaymentService.java", 7],
      ["com.acme.payments.PaymentService.charge", "com.acme.payments.StripeGateway.authorize", "calls", "src/main/java/com/acme/payments/PaymentService.java", 22],
      ["com.acme.payments.PaymentService", "payment.timeout-ms", "reads-config", "src/main/java/com/acme/payments/PaymentService.java", 11],
      ["ADR-021#Decision", "com.acme.payments.StripeGateway", "documents", "docs/ADR-021.md", 8]
    ]),
    projection("payroll-private", payroll, [
      ["corp.payroll.SecretPayrollExporter", "corp.payroll.SecretPayrollExporter.export", "contains", "src/main/java/corp/payroll/SecretPayrollExporter.java", 6],
      ["corp.payroll.SecretPayrollExporter", "payroll.ssn-key", "reads-config", "src/main/java/corp/payroll/SecretPayrollExporter.java", 10]
    ]),
    projection("admin-private", admin, [
      ["corp.admin.RootAdminController", "corp.admin.RootAdminController.disableAudit", "contains", "src/main/java/corp/admin/RootAdminController.java", 6]
    ]),
  ];
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

function seedVault(vault, engine) {
  const knownNodeIds = new Set();
  const knownEdgeKeys = new Set();
  const nodeProjects = new Map();
  for (const graph of graphCorpus()) {
    for (const node of graph.nodes) {
      const nodeId = graphNodeId({ ...node, tenant_id: "local", project_id: graph.project_id });
      knownNodeIds.add(nodeId);
      nodeProjects.set(nodeId, graph.project_id);
    }
    for (const edge of graph.edges) {
      const sourceId = graphNodeId({ ...edge.source, tenant_id: "local", project_id: graph.project_id });
      const targetId = graphNodeId({ ...edge.target, tenant_id: "local", project_id: graph.project_id });
      knownEdgeKeys.add(`${edge.relation}\0${sourceId}\0${targetId}`);
    }
    vault.publishGraph(graph);
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
  return Promise.all([...memoryIds.values()].map((id) => engine.indexMemory(id)))
    .then(() => ({ knownNodeIds, knownEdgeKeys, memoryIds, nodeProjects }));
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
      if (result.citation?.git_commit && result.citation.git_commit !== COMMIT) reasons.push(`${result.id}:citation-commit`);
      if ((result.graph_path || []).some((edge) => edge.commit && edge.commit !== COMMIT)) reasons.push(`${result.id}:path-commit`);
      return reasons;
    }),
    ...generationCommits(pack.retrieval)
      .filter((commit) => commit && commit !== COMMIT)
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

export async function runGraphFirstBenchmark({ promotionRequested = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-graph-first-benchmark-"));
  const vault = new ContextVault(root);
  const embedder = new DeterministicBenchmarkEmbedder();
  const engine = new HybridEngine(vault, embedder);
  try {
    const { knownNodeIds, knownEdgeKeys, memoryIds, nodeProjects } = await seedVault(vault, engine);
    validateFixture(knownNodeIds, knownEdgeKeys, memoryIds);
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
          top_k: fixture.top_k,
          token_budget: fixture.token_budget,
        });
        observations.push(observeBenchmarkQuery(
          query, mode, pack, performance.now() - started,
          embedder.queryCalls - callsBefore, memoryIds, nodeProjects,
        ));
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
    const tokenReduction = 1 - modes["graph-first"].median_context_tokens / modes.hybrid.median_context_tokens;
    const gates = {
      no_answer_accuracy_regression: false,
      median_context_token_reduction_at_least_20_percent: tokenReduction >= 0.2,
      exact_structural_embedding_avoidance_at_least_60_percent:
        modes["graph-first"].structural_embedding_avoidance_rate >= 0.6,
      zero_cross_scope_failures: crossScopeFailures === 0,
      zero_stale_generation_failures: staleGenerationFailures === 0,
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
        graph_generations: graphCorpus().length,
        records: MEMORY_CORPUS.length,
        modes: MODES,
        latency_clock: "performance.now",
        context_token_estimator: "ContinuityDB estimateSerializedTokens with volatile timestamps, scores, and self-measurement fields canonicalized",
      },
      modes,
      by_query_class: byQueryClass,
      security: {
        cross_scope_failures: crossScopeFailures,
        stale_generation_failures: staleGenerationFailures,
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
  if (report.security.cross_scope_failures || report.security.stale_generation_failures) process.exitCode = 2;
  if (promotionRequested && !report.release_gates.passed) process.exitCode = 3;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
