import { createHash } from "node:crypto";
import { posix as path } from "node:path";

export const GRAPH_RELATIONS = new Set([
  "contains", "declares", "imports", "calls", "implements", "extends",
  "depends-on", "reads-config", "writes-config", "exposes", "consumes",
  "documents", "supports", "contradicts", "supersedes", "affects",
]);

const GRAPH_PROVENANCE = new Set(["extracted", "resolved", "inferred"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name);
}

function bounded(value, min, max, name) {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return Math.min(max, Math.max(min, value));
}

export function normalizeGraphPath(value, name = "repo_path") {
  const raw = requiredString(value, name).replaceAll("\\", "/");
  if (raw.includes("\u0000") || raw.startsWith("/") || /^[a-z]:\//i.test(raw)) {
    throw new Error(`${name} must be a repository-relative path`);
  }
  const normalized = path.normalize(raw).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${name} must be a repository-relative path`);
  }
  return normalized;
}

function optionalInteger(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function normalizeProvenance(value, name = "edge provenance") {
  const provenance = value || "extracted";
  if (!GRAPH_PROVENANCE.has(provenance)) throw new Error(`${name} is invalid`);
  return provenance;
}

function defaultWeight(provenance) {
  if (provenance === "extracted") return 1;
  if (provenance === "resolved") return 0.9;
  return 0.5;
}

function normalizeWeight(value, provenance) {
  const weight = value === undefined ? defaultWeight(provenance) : Number(value);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error("edge weight must be between 0 and 1");
  }
  if (provenance === "inferred" && weight >= 1) {
    throw new Error("inferred edge weight must be less than extracted edge weight");
  }
  return weight;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeScope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("graph projection must be an object");
  return {
    tenant_id: requiredString(input.tenant_id, "tenant_id"),
    project_id: requiredString(input.project_id, "project_id"),
    branch: optionalString(input.branch, "branch"),
    commit: requiredString(input.commit, "commit"),
    extractor_version: requiredString(input.extractor_version, "extractor_version"),
  };
}

export function graphNodeId(input) {
  const identity = [
    requiredString(input?.tenant_id, "tenant_id"),
    requiredString(input?.project_id, "project_id"),
    normalizeGraphPath(input?.repo_path),
    requiredString(input?.kind, "kind"),
    requiredString(input?.qualified_name, "qualified_name"),
  ].join("\u0000");
  return `gn_${hash(identity)}`;
}

export function graphEdgeId(input) {
  const sourceId = requiredString(input?.source_id, "source_id");
  const targetId = requiredString(input?.target_id, "target_id");
  const relation = requiredString(input?.relation, "relation");
  if (!GRAPH_RELATIONS.has(relation)) throw new Error("graph relation is invalid");
  const sourceLocation = canonicalSourceLocation(input);
  return `ge_${hash([sourceId, targetId, relation, sourceLocation].join("\u0000"))}`;
}

function canonicalSourceLocation(input) {
  if (input?.source_location !== undefined && input?.source_location !== null) {
    const raw = requiredString(input.source_location, "source_location");
    const separator = raw.indexOf(":");
    const repoPath = separator === -1 ? raw : raw.slice(0, separator);
    return `${normalizeGraphPath(repoPath, "source_location")}${separator === -1 ? "" : raw.slice(separator)}`;
  }
  return [
    input?.repo_path === undefined || input?.repo_path === null ? "" : normalizeGraphPath(input.repo_path),
    optionalInteger(input?.start_line, "start_line") ?? "",
    optionalInteger(input?.start_column, "start_column") ?? "",
    optionalInteger(input?.end_line, "end_line") ?? "",
    optionalInteger(input?.end_column, "end_column") ?? "",
  ].join(":");
}

function normalizeNode(input, scope) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("graph node must be an object");
  const node = {
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    repo_path: normalizeGraphPath(input.repo_path),
    kind: requiredString(input.kind, "node kind"),
    qualified_name: requiredString(input.qualified_name, "qualified_name"),
    label: optionalString(input.label, "node label") || requiredString(input.qualified_name, "qualified_name"),
    branch: scope.branch,
    commit: optionalString(input.commit, "node commit") || scope.commit,
    content_hash: optionalString(input.content_hash, "content_hash"),
    language: optionalString(input.language, "language"),
    start_line: optionalInteger(input.start_line, "start_line"),
    start_column: optionalInteger(input.start_column, "start_column"),
    end_line: optionalInteger(input.end_line, "end_line"),
    end_column: optionalInteger(input.end_column, "end_column"),
    extractor_version: optionalString(input.extractor_version, "node extractor_version") || scope.extractor_version,
    provenance: normalizeProvenance(input.provenance, "node provenance"),
    valid_from: optionalString(input.valid_from, "valid_from"),
    valid_to: optionalString(input.valid_to, "valid_to"),
    stale: input.stale ? 1 : 0,
  };
  if (node.valid_from && node.valid_to && node.valid_from >= node.valid_to) {
    throw new Error("node valid_from must be earlier than valid_to");
  }
  return { ...node, id: graphNodeId(node) };
}

function nodeIdForReference(reference, scope) {
  if (typeof reference === "string") return requiredString(reference, "edge endpoint");
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("edge endpoint must be a node ID or node identity");
  }
  if (reference.id) return requiredString(reference.id, "edge endpoint");
  return graphNodeId({ ...scope, ...reference });
}

function normalizeEdge(input, scope) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("graph edge must be an object");
  const relation = requiredString(input.relation, "edge relation");
  if (!GRAPH_RELATIONS.has(relation)) throw new Error("graph relation is invalid");
  const provenance = normalizeProvenance(input.provenance);
  const edge = {
    source_id: nodeIdForReference(input.source_id ?? input.source, scope),
    target_id: nodeIdForReference(input.target_id ?? input.target, scope),
    relation,
    source_location: canonicalSourceLocation(input),
    repo_path: input.repo_path === undefined || input.repo_path === null ? null : normalizeGraphPath(input.repo_path),
    start_line: optionalInteger(input.start_line, "start_line"),
    start_column: optionalInteger(input.start_column, "start_column"),
    end_line: optionalInteger(input.end_line, "end_line"),
    end_column: optionalInteger(input.end_column, "end_column"),
    weight: normalizeWeight(input.weight, provenance),
    provenance,
    commit: optionalString(input.commit, "edge commit") || scope.commit,
    extractor_version: optionalString(input.extractor_version, "edge extractor_version") || scope.extractor_version,
    valid_from: optionalString(input.valid_from, "valid_from"),
    valid_to: optionalString(input.valid_to, "valid_to"),
    stale: input.stale ? 1 : 0,
  };
  if (edge.valid_from && edge.valid_to && edge.valid_from >= edge.valid_to) {
    throw new Error("edge valid_from must be earlier than valid_to");
  }
  return { ...edge, id: graphEdgeId(edge) };
}

function normalizeSourceState(input, scope) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("graph source state must be an object");
  return {
    tenant_id: scope.tenant_id,
    repo_path: normalizeGraphPath(input.repo_path),
    git_object_id: requiredString(input.git_object_id ?? input.object_id, "git_object_id"),
    content_hash: optionalString(input.content_hash, "content_hash"),
    extractor_version: optionalString(input.extractor_version, "source extractor_version") || scope.extractor_version,
  };
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function normalizeGraphProjection(input) {
  const scope = normalizeScope(input);
  if (!Array.isArray(input.source_states) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new Error("graph projection source_states, nodes, and edges must be arrays");
  }
  const source_states = input.source_states.map((state) => normalizeSourceState(state, scope))
    .sort((left, right) => left.repo_path.localeCompare(right.repo_path));
  const nodes = input.nodes.map((node) => normalizeNode(node, scope))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = input.edges.map((edge) => normalizeEdge(edge, scope))
    .sort((left, right) => left.id.localeCompare(right.id));
  unique(source_states, (state) => state.repo_path, "source state");
  unique(nodes, (node) => node.id, "graph node");
  unique(edges, (edge) => edge.id, "graph edge");
  const canonical = { ...scope, source_states, nodes, edges };
  return { ...canonical, hash: `gp_${hash(JSON.stringify(canonical))}` };
}

export function normalizeGraphBudgets({ depth = 2, maxVisited = 400, maxPaths = 40 } = {}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error("depth must be between 0 and 3");
  return {
    depth,
    maxVisited: bounded(maxVisited, 25, 2_000, "maxVisited"),
    maxPaths: bounded(maxPaths, 1, 200, "maxPaths"),
  };
}
