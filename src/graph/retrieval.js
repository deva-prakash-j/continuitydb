import { normalizeGraphBudgets } from "./model.js";
import { requiredIdentifier } from "../security.js";

const LOCAL_TENANT = "local";
const PROVENANCE_SCORE = Object.freeze({ extracted: 1, resolved: 0.9, inferred: 0.45 });
const RELATION_SCORE = Object.freeze({
  calls: 1, "depends-on": 0.98, implements: 0.96, extends: 0.94,
  imports: 0.9, consumes: 0.9, exposes: 0.88, "reads-config": 0.86,
  "writes-config": 0.84, declares: 0.8, contains: 0.76, affects: 0.72,
  supports: 0.68, documents: 0.64, supersedes: 0.62, contradicts: 0.58,
});
const STOP_WORDS = new Set(["a", "an", "and", "are", "by", "does", "for", "from", "how", "is", "of", "the", "to", "what", "where", "which", "who", "why"]);

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalTime(value) {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("as_of must be an ISO-8601 timestamp");
  return new Date(timestamp).toISOString();
}

function queryTerms(query) {
  const text = requiredString(query, "query");
  const quoted = [...text.matchAll(/["']([^"']{2,200})["']/g)].map((match) => match[1]);
  const tokens = text.match(/[\p{L}\p{N}_@.$:/#-]+/gu) || [];
  return [...new Set([...quoted, ...tokens]
    .map((value) => value.replace(/^[#.:/]+|[#.:/?,!]+$/g, "").toLowerCase())
    .filter((value) => value.length > 1 && !STOP_WORDS.has(value)))]
    .slice(0, 32);
}

function ftsExpression(terms) {
  const tokens = terms.flatMap((term) => term.match(/[\p{L}\p{N}_]+/gu) || [])
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
    .slice(0, 32);
  return [...new Set(tokens)].map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export function authorizedScope(vault, input) {
  const tenantId = requiredIdentifier(input.tenant_id || LOCAL_TENANT, "tenant_id");
  if (!input.project_id) return { tenantId, projects: [], generations: [], effectiveTime: optionalTime(input.as_of) };
  const projectId = requiredIdentifier(input.project_id, "project_id");
  const allowedProjects = [...new Set((input.allowed_projects || []).map((item) => requiredIdentifier(item, "allowed project")))];
  const projects = [...vault.dependencies(
    projectId,
    Math.min(5, Math.max(0, Number(input.dependency_depth ?? 2))),
    allowedProjects,
    tenantId,
  ).keys()].sort();
  const generations = projects.flatMap((project) => {
    const request = { tenant_id: tenantId, project_id: project };
    if (input.branch !== undefined && input.branch !== null && input.branch !== "") {
      request.branch = requiredIdentifier(input.branch, "branch");
    }
    const generation = vault.activeGraphGeneration(request);
    return generation ? [generation] : [];
  });
  return { tenantId, projectId, projects, generations, effectiveTime: optionalTime(input.as_of) };
}

function graphPredicate(input, alias = "n") {
  return `
    ${alias}.tenant_id = ?
    AND ${alias}.project_id IN (SELECT value FROM json_each(?))
    AND ${alias}.generation_id IN (SELECT value FROM json_each(?))
    AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)
    AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)
    AND (? = 1 OR ${alias}.stale = 0)
    AND (? = 0 OR ${alias}.provenance IN ('extracted', 'resolved'))
  `;
}

function graphPredicateValues(scope, input) {
  return [
    scope.tenantId,
    JSON.stringify(scope.projects),
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    scope.effectiveTime,
    scope.effectiveTime,
    input.include_stale ? 1 : 0,
    input.strict_evidence ? 1 : 0,
  ];
}

function publicNode(row) {
  return {
    id: row.id,
    generation_id: row.generation_id,
    project_id: row.project_id,
    repo_path: row.repo_path,
    kind: row.kind,
    qualified_name: row.qualified_name,
    label: row.label,
    branch: row.branch || null,
    commit: row.commit,
    language: row.language,
    start_line: row.start_line,
    start_column: row.start_column,
    end_line: row.end_line,
    end_column: row.end_column,
    provenance: row.provenance,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    stale: Boolean(row.stale),
  };
}

function stableCandidates(rows) {
  return rows.sort((left, right) => right.score - left.score
    || left.depth - right.depth
    || left.id.localeCompare(right.id));
}

export function resolveGraphSeeds(vault, input = {}) {
  if (!vault?.db || typeof vault.dependencies !== "function") throw new Error("vault must provide graph storage and authorization");
  const terms = queryTerms(input.query);
  const scope = authorizedScope(vault, input);
  if (!terms.length || !scope.generations.length) return [];
  const limit = Math.min(100, Math.max(1, Number(input.seed_limit ?? 40)));
  const values = graphPredicateValues(scope, input);
  const exact = vault.db.prepare(`
    SELECT n.*
    FROM graph_nodes n
    JOIN graph_generations g ON g.tenant_id = n.tenant_id AND g.id = n.generation_id
    WHERE ${graphPredicate(input, "n")}
      AND g.status = 'active'
      AND g.project_id IN (SELECT value FROM json_each(?))
      AND g.id IN (SELECT value FROM json_each(?))
      AND g.branch IN (SELECT value FROM json_each(?))
      AND COALESCE(n.branch, '') = g.branch
      AND EXISTS (
        SELECT 1 FROM json_each(?) term
        WHERE lower(n.id) = term.value
           OR lower(n.qualified_name) = term.value
           OR lower(n.qualified_name) LIKE '%.' || replace(replace(term.value, '%', '\\%'), '_', '\\_') ESCAPE '\\'
           OR lower(n.label) = term.value
           OR lower(n.repo_path) = term.value
           OR lower(n.repo_path) LIKE '%/' || replace(replace(term.value, '%', '\\%'), '_', '\\_') ESCAPE '\\'
      )
    ORDER BY n.qualified_name, n.id
    LIMIT ?
  `).all(
    ...values,
    JSON.stringify(scope.projects),
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    JSON.stringify(scope.generations.map((generation) => generation.branch || "")),
    JSON.stringify(terms),
    limit,
  ).map((row) => {
    const normalized = publicNode(row);
    const fields = [normalized.id, normalized.qualified_name, normalized.label, normalized.repo_path].map((value) => value.toLowerCase());
    const strength = terms.reduce((best, term) => {
      const exactField = fields.includes(term);
      const qualifiedSuffix = fields[1].endsWith(`.${term}`);
      const pathSuffix = fields[3].endsWith(`/${term}`);
      return Math.max(best, exactField ? 1 : (qualifiedSuffix || pathSuffix) ? 0.96 : 0);
    }, 0.9);
    return { ...normalized, seed_match: "exact", score: strength, depth: 0, graph_path: [] };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  // A qualified/path/config/error exact match is a complete structural seed;
  // broad package-token FTS matches would otherwise bypass the evidence path.
  if (exact.length) return exact;
  const remaining = limit;
  const fts = ftsExpression(terms);
  if (remaining <= 0 || !fts) return exact;
  const exactIds = exact.map((row) => row.id);
  const lexical = vault.db.prepare(`
    SELECT n.*, bm25(graph_node_fts, 0.0, 0.0, 0.0, 8.0, 5.0, 3.0) AS lexical_rank
    FROM graph_node_fts
    JOIN graph_nodes n
      ON n.tenant_id = graph_node_fts.tenant_id
     AND n.generation_id = graph_node_fts.generation_id
     AND n.id = graph_node_fts.node_id
    JOIN graph_generations g ON g.tenant_id = n.tenant_id AND g.id = n.generation_id
    WHERE graph_node_fts MATCH ?
      AND ${graphPredicate(input, "n")}
      AND g.status = 'active'
      AND g.project_id IN (SELECT value FROM json_each(?))
      AND g.id IN (SELECT value FROM json_each(?))
      AND g.branch IN (SELECT value FROM json_each(?))
      AND COALESCE(n.branch, '') = g.branch
      AND n.id NOT IN (SELECT value FROM json_each(?))
    ORDER BY lexical_rank, n.id
    LIMIT ?
  `).all(
    fts,
    ...values,
    JSON.stringify(scope.projects),
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    JSON.stringify(scope.generations.map((generation) => generation.branch || "")),
    JSON.stringify(exactIds),
    remaining,
  ).map((row, index) => ({
    ...publicNode(row), seed_match: "fts", score: 0.72 / (1 + index * 0.03), depth: 0, graph_path: [],
  }));
  return [...exact, ...lexical];
}

export function authorizedGraphEdges(vault, scope, input, nodeIds) {
  if (!nodeIds.length || !scope.generations.length) return [];
  return vault.db.prepare(`
    SELECT e.*,
      source.project_id AS source_project_id, source.qualified_name AS source_qualified_name,
      source.label AS source_label, source.kind AS source_kind, source.repo_path AS source_repo_path,
      target.project_id AS target_project_id, target.qualified_name AS target_qualified_name,
      target.label AS target_label, target.kind AS target_kind, target.repo_path AS target_repo_path
    FROM graph_edges e
    JOIN graph_generations g ON g.tenant_id = e.tenant_id AND g.id = e.generation_id
    JOIN graph_nodes source
      ON source.tenant_id = e.tenant_id AND source.generation_id = e.generation_id AND source.id = e.source_id
    JOIN graph_nodes target
      ON target.tenant_id = e.tenant_id AND target.generation_id = e.generation_id AND target.id = e.target_id
    WHERE e.tenant_id = ?
      AND e.generation_id IN (SELECT value FROM json_each(?))
      AND g.status = 'active'
      AND g.project_id IN (SELECT value FROM json_each(?))
      AND g.branch IN (SELECT value FROM json_each(?))
      AND COALESCE(source.branch, '') = g.branch
      AND COALESCE(target.branch, '') = g.branch
      AND (e.source_id IN (SELECT value FROM json_each(?)) OR e.target_id IN (SELECT value FROM json_each(?)))
      AND (e.valid_from IS NULL OR e.valid_from <= ?)
      AND (e.valid_to IS NULL OR e.valid_to > ?)
      AND (? = 1 OR e.stale = 0)
      AND (? = 0 OR e.provenance IN ('extracted', 'resolved'))
      AND source.tenant_id = ? AND target.tenant_id = ?
      AND source.project_id IN (SELECT value FROM json_each(?))
      AND target.project_id IN (SELECT value FROM json_each(?))
      AND source.generation_id IN (SELECT value FROM json_each(?))
      AND target.generation_id IN (SELECT value FROM json_each(?))
      AND (source.valid_from IS NULL OR source.valid_from <= ?)
      AND (source.valid_to IS NULL OR source.valid_to > ?)
      AND (target.valid_from IS NULL OR target.valid_from <= ?)
      AND (target.valid_to IS NULL OR target.valid_to > ?)
      AND (? = 1 OR (source.stale = 0 AND target.stale = 0))
      AND (? = 0 OR (source.provenance IN ('extracted', 'resolved') AND target.provenance IN ('extracted', 'resolved')))
    ORDER BY e.id
  `).all(
    scope.tenantId,
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    JSON.stringify(scope.projects),
    JSON.stringify(scope.generations.map((generation) => generation.branch || "")),
    JSON.stringify(nodeIds),
    JSON.stringify(nodeIds),
    scope.effectiveTime,
    scope.effectiveTime,
    input.include_stale ? 1 : 0,
    input.strict_evidence ? 1 : 0,
    scope.tenantId,
    scope.tenantId,
    JSON.stringify(scope.projects),
    JSON.stringify(scope.projects),
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    scope.effectiveTime,
    scope.effectiveTime,
    scope.effectiveTime,
    scope.effectiveTime,
    input.include_stale ? 1 : 0,
    input.strict_evidence ? 1 : 0,
  );
}

function authorizedSeedNodes(vault, scope, input, seeds) {
  if (!seeds.length || !scope.generations.length) return [];
  const requested = new Map(seeds
    .filter((seed) => typeof seed?.id === "string")
    .map((seed) => [seed.id, seed]));
  if (!requested.size) return [];
  const rows = vault.db.prepare(`
    SELECT n.*
    FROM graph_nodes n
    JOIN graph_generations g ON g.tenant_id = n.tenant_id AND g.id = n.generation_id
    WHERE ${graphPredicate(input, "n")}
      AND n.id IN (SELECT value FROM json_each(?))
      AND g.status = 'active'
      AND g.project_id IN (SELECT value FROM json_each(?))
      AND g.id IN (SELECT value FROM json_each(?))
      AND g.branch IN (SELECT value FROM json_each(?))
      AND COALESCE(n.branch, '') = g.branch
    ORDER BY n.id
  `).all(
    ...graphPredicateValues(scope, input),
    JSON.stringify([...requested.keys()]),
    JSON.stringify(scope.projects),
    JSON.stringify(scope.generations.map((generation) => generation.id)),
    JSON.stringify(scope.generations.map((generation) => generation.branch || "")),
  );
  return rows.map((row) => {
    const supplied = requested.get(row.id);
    return {
      ...publicNode(row),
      seed_match: supplied.seed_match === "exact" ? "exact" : "fts",
      score: Math.max(0, Math.min(1, Number(supplied.score || 0))),
      depth: 0,
      graph_path: [],
    };
  });
}

function citedHop(edge, direction) {
  return {
    edge_id: edge.id,
    source_id: edge.source_id,
    source_label: edge.source_label,
    target_id: edge.target_id,
    target_label: edge.target_label,
    relation: edge.relation,
    direction,
    provenance: edge.provenance,
    weight: Number(edge.weight),
    source_location: edge.source_location,
    commit: edge.commit,
  };
}

function neighborFromEdge(edge, currentId, direction) {
  if ((direction === "outgoing" || direction === "both") && edge.source_id === currentId) {
    return {
      id: edge.target_id, generation_id: edge.generation_id, project_id: edge.target_project_id,
      qualified_name: edge.target_qualified_name, label: edge.target_label, kind: edge.target_kind,
      repo_path: edge.target_repo_path, direction: "outgoing",
    };
  }
  if ((direction === "incoming" || direction === "both") && edge.target_id === currentId) {
    return {
      id: edge.source_id, generation_id: edge.generation_id, project_id: edge.source_project_id,
      qualified_name: edge.source_qualified_name, label: edge.source_label, kind: edge.source_kind,
      repo_path: edge.source_repo_path, direction: "incoming",
    };
  }
  return null;
}

function inferredDirection(input) {
  if (input.direction !== undefined) {
    if (!["incoming", "outgoing", "both"].includes(input.direction)) throw new Error("direction must be incoming, outgoing, or both");
    return input.direction;
  }
  const query = String(input.query || "").toLowerCase();
  if (/\b(?:who|what)\s+(?:calls|uses|imports|depends)|\bcalled by\b/.test(query)) return "incoming";
  if (/\b(?:calls|uses|imports|depends on|reads|writes)\s+(?:from\s+)?what\b/.test(query)) return "outgoing";
  return "both";
}

export function traverseGraph(vault, input = {}) {
  const budgets = normalizeGraphBudgets({
    depth: input.depth ?? input.graph_depth ?? 2,
    maxVisited: input.maxVisited ?? input.graph_max_visited ?? 400,
    maxPaths: input.maxPaths ?? input.graph_max_paths ?? 40,
  });
  const direction = inferredDirection(input);
  const scope = authorizedScope(vault, input);
  const seeds = authorizedSeedNodes(vault, scope, input, input.seeds || resolveGraphSeeds(vault, input));
  const authorizedGenerationIds = new Set(scope.generations.map((generation) => generation.id));
  const authorizedProjects = new Set(scope.projects);
  let frontier = seeds
    .filter((seed) => authorizedGenerationIds.has(seed.generation_id) && authorizedProjects.has(seed.project_id))
    .slice(0, budgets.maxVisited);
  const visited = new Map(frontier.map((seed) => [seed.id, seed.score]));
  const candidates = stableCandidates(frontier.map((seed) => ({ ...seed, depth: 0, graph_path: seed.graph_path || [] })))
    .slice(0, budgets.maxPaths);
  let depth = 0;
  while (frontier.length && depth < budgets.depth && visited.size < budgets.maxVisited && candidates.length < budgets.maxPaths) {
    const frontierById = new Map(frontier.map((item) => [item.id, item]));
    const edges = authorizedGraphEdges(vault, scope, input, [...frontierById.keys()]);
    const nextById = new Map();
    for (const edge of edges) {
      for (const currentId of [edge.source_id, edge.target_id]) {
        const current = frontierById.get(currentId);
        if (!current) continue;
        const neighbor = neighborFromEdge(edge, currentId, direction);
        if (!neighbor || neighbor.id === currentId) continue;
        const hop = depth + 1;
        const score = current.score
          * (RELATION_SCORE[edge.relation] ?? 0.6)
          * (PROVENANCE_SCORE[edge.provenance] ?? 0)
          * Number(edge.weight)
          * (0.82 ** hop);
        if (score <= (visited.get(neighbor.id) ?? Number.NEGATIVE_INFINITY)) continue;
        const candidate = {
          ...neighbor,
          branch: current.branch ?? null,
          commit: edge.commit,
          language: null,
          provenance: edge.provenance,
          valid_from: edge.valid_from,
          valid_to: edge.valid_to,
          stale: Boolean(edge.stale),
          seed_match: current.seed_match,
          score,
          depth: hop,
          graph_path: [...current.graph_path, citedHop(edge, neighbor.direction)],
        };
        const prior = nextById.get(neighbor.id);
        if (!prior || score > prior.score || (score === prior.score && JSON.stringify(candidate.graph_path) < JSON.stringify(prior.graph_path))) {
          nextById.set(neighbor.id, candidate);
        }
      }
    }
    const next = stableCandidates([...nextById.values()]);
    frontier = [];
    for (const candidate of next) {
      if (visited.size >= budgets.maxVisited || candidates.length >= budgets.maxPaths) break;
      visited.set(candidate.id, candidate.score);
      frontier.push(candidate);
      candidates.push(candidate);
    }
    depth += 1;
  }
  return stableCandidates(candidates).slice(0, budgets.maxPaths);
}

export function evaluateGraphCoverage({ query = "", seeds = [], candidates = [], minimum_candidates = 1, minimum_path_score = 0.2 } = {}) {
  const exactSeeds = seeds.filter((seed) => seed.seed_match === "exact");
  const bestPathScore = candidates.reduce((best, candidate) => Math.max(best, Number(candidate.score || 0)), 0);
  let fallbackReason = null;
  if (!seeds.length) fallbackReason = "no_seed";
  else if (candidates.length < Math.max(1, Number(minimum_candidates))) fallbackReason = "insufficient_candidates";
  else if (bestPathScore < Number(minimum_path_score)) fallbackReason = "low_path_confidence";
  else if (!exactSeeds.length && query.trim().split(/\s+/).length >= 5) fallbackReason = "conceptual_query";
  return {
    sufficient: fallbackReason === null,
    should_fallback: fallbackReason !== null,
    fallback_reason: fallbackReason,
    seed_count: seeds.length,
    exact_seed_count: exactSeeds.length,
    candidate_count: candidates.length,
    best_path_score: bestPathScore,
  };
}

export function graphGenerationSummary(vault, input) {
  const generations = authorizedScope(vault, input).generations
    .map(({ id, project_id, branch, commit }) => ({ id, project_id, branch, commit }))
    .sort((left, right) => left.project_id.localeCompare(right.project_id) || left.id.localeCompare(right.id));
  if (!generations.length) return null;
  return generations.length === 1 ? generations[0] : generations;
}
