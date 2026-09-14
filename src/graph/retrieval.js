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
const SENSITIVITIES = new Set(["public", "private", "sensitive", "restricted"]);

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

function normalizedSensitivities(input) {
  const supplied = input.allowed_sensitivities === undefined
    ? ["public", "private"]
    : input.allowed_sensitivities;
  if (!Array.isArray(supplied)) throw new Error("allowed_sensitivities must be an array");
  return [...new Set(supplied.filter((value) => SENSITIVITIES.has(value)))];
}

export function authorizedScope(vault, input = {}) {
  const tenantId = requiredIdentifier(input.tenant_id || LOCAL_TENANT, "tenant_id");
  const ownerId = requiredIdentifier(input.owner_id || "local-user", "owner_id");
  const effectiveTime = optionalTime(input.as_of);
  const branch = input.branch === undefined || input.branch === null || input.branch === ""
    ? ""
    : requiredIdentifier(input.branch, "branch");
  const sensitivities = normalizedSensitivities(input);
  if (!input.project_id) {
    return {
      tenantId, ownerId, projects: [], namespaces: [], sensitivities,
      generations: [], effectiveTime, branch,
    };
  }
  const projectId = requiredIdentifier(input.project_id, "project_id");
  const allowedProjects = [...new Set((input.allowed_projects || [])
    .map((item) => requiredIdentifier(item, "allowed project")))];
  const projects = [...vault.dependencies(
    projectId,
    Math.min(5, Math.max(0, Number(input.dependency_depth ?? 2))),
    allowedProjects,
    tenantId,
    effectiveTime,
  ).keys()].sort();
  const namespaces = ["personal/global", ...projects.map((project) => `project/${project}`)];
  const generations = sensitivities.length ? projects.flatMap((project) => {
    const generation = vault.activeGraphGeneration({
      tenant_id: tenantId,
      owner_id: ownerId,
      project_id: project,
      branch: branch || null,
      as_of: input.as_of || null,
      include_stale: Boolean(input.include_stale),
      allowed_namespaces: namespaces,
      allowed_sensitivities: sensitivities,
    });
    return generation ? [generation] : [];
  }) : [];
  return {
    tenantId, ownerId, projectId, projects, namespaces, sensitivities,
    generations, effectiveTime, branch,
  };
}

function nodePolicy(scope, input, alias) {
  const excludedTypes = Array.isArray(input.exclude_types) ? input.exclude_types : [];
  return {
    sql: `
      ${alias}.tenant_id = ?
      AND ${alias}.owner_id = ?
      AND ${alias}.project_id IN (SELECT value FROM json_each(?))
      AND ${alias}.generation_id IN (SELECT value FROM json_each(?))
      AND ${alias}.namespace_id IN (SELECT value FROM json_each(?))
      AND ${alias}.sensitivity IN (SELECT value FROM json_each(?))
      AND ${alias}.lifecycle_status = 'active'
      AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)
      AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)
      AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)
      AND (? = 1 OR ${alias}.stale = 0)
      AND (? = 0 OR ${alias}.provenance IN ('extracted', 'resolved'))
      AND (${alias}.memory_id IS NOT NULL OR COALESCE(${alias}.branch, '') = ?)
      AND (${alias}.memory_id IS NULL OR EXISTS (
        SELECT 1 FROM memory_records governed
        WHERE governed.id = ${alias}.memory_id
          AND governed.tenant_id = ? AND governed.owner_id = ?
          AND governed.project_id IN (SELECT value FROM json_each(?))
          AND governed.namespace_id IN (SELECT value FROM json_each(?))
          AND governed.sensitivity IN (SELECT value FROM json_each(?))
          AND governed.type NOT IN (SELECT value FROM json_each(?))
          AND governed.status = 'active'
          AND (governed.valid_from IS NULL OR governed.valid_from <= ?)
          AND (governed.valid_to IS NULL OR governed.valid_to > ?)
          AND (governed.expires_at IS NULL OR governed.expires_at > ?)
          AND (? = 1 OR governed.stale = 0)
          AND ((? = '' AND governed.branch IS NULL)
            OR (? != '' AND (governed.branch IS NULL OR governed.branch = ?)))
      ))
    `,
    values: [
      scope.tenantId,
      scope.ownerId,
      JSON.stringify(scope.projects),
      JSON.stringify(scope.generations.map((generation) => generation.id)),
      JSON.stringify(scope.namespaces),
      JSON.stringify(scope.sensitivities),
      scope.effectiveTime,
      scope.effectiveTime,
      scope.effectiveTime,
      input.include_stale ? 1 : 0,
      input.strict_evidence ? 1 : 0,
      scope.branch,
      scope.tenantId,
      scope.ownerId,
      JSON.stringify(scope.projects),
      JSON.stringify(scope.namespaces),
      JSON.stringify(scope.sensitivities),
      JSON.stringify(excludedTypes),
      scope.effectiveTime,
      scope.effectiveTime,
      scope.effectiveTime,
      input.include_stale ? 1 : 0,
      scope.branch,
      scope.branch,
      scope.branch || null,
    ],
  };
}

function edgePolicy(scope, input, alias = "e") {
  return {
    sql: `
      ${alias}.tenant_id = ? AND ${alias}.owner_id = ?
      AND ${alias}.project_id IN (SELECT value FROM json_each(?))
      AND ${alias}.generation_id IN (SELECT value FROM json_each(?))
      AND ${alias}.namespace_id IN (SELECT value FROM json_each(?))
      AND ${alias}.sensitivity IN (SELECT value FROM json_each(?))
      AND ${alias}.lifecycle_status = 'active'
      AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)
      AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)
      AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)
      AND (? = 1 OR ${alias}.stale = 0)
      AND (? = 0 OR ${alias}.provenance IN ('extracted', 'resolved'))
      AND ((? = '' AND COALESCE(${alias}.branch, '') = '')
        OR (? != '' AND (${alias}.branch IS NULL OR ${alias}.branch = ?)))
    `,
    values: [
      scope.tenantId,
      scope.ownerId,
      JSON.stringify(scope.projects),
      JSON.stringify(scope.generations.map((generation) => generation.id)),
      JSON.stringify(scope.namespaces),
      JSON.stringify(scope.sensitivities),
      scope.effectiveTime,
      scope.effectiveTime,
      scope.effectiveTime,
      input.include_stale ? 1 : 0,
      input.strict_evidence ? 1 : 0,
      scope.branch,
      scope.branch,
      scope.branch || null,
    ],
  };
}

function boundedExcerpt(value) {
  let output = String(value || "").trim();
  while (Buffer.byteLength(output, "utf8") > 512) output = output.slice(0, Math.floor(output.length * 0.9)).trimEnd();
  return output;
}

function publicNode(vault, row) {
  let governed = null;
  if (row.memory_id) governed = vault.db.prepare(`
    SELECT id, title, body, project_id, namespace_id, sensitivity, branch, git_commit,
      repo_path, symbol, valid_from, valid_to, stale
    FROM memory_records WHERE id = ?
  `).get(row.memory_id);
  return {
    id: row.id,
    memory_id: row.memory_id || null,
    generation_id: row.generation_id,
    owner_id: row.owner_id,
    project_id: governed?.project_id || row.project_id,
    namespace_id: governed?.namespace_id || row.namespace_id,
    sensitivity: governed?.sensitivity || row.sensitivity,
    repo_path: governed?.repo_path || row.repo_path,
    kind: row.kind,
    qualified_name: row.qualified_name,
    label: governed?.title || row.label,
    excerpt: governed?.body ? boundedExcerpt(governed.body) : row.excerpt,
    branch: governed?.branch ?? row.branch ?? null,
    commit: governed?.git_commit || row.commit,
    language: row.language,
    start_line: row.start_line,
    start_column: row.start_column,
    end_line: row.end_line,
    end_column: row.end_column,
    provenance: row.provenance,
    valid_from: governed?.valid_from || row.valid_from,
    valid_to: governed?.valid_to || row.valid_to,
    stale: Boolean(governed?.stale ?? row.stale),
  };
}

function stableCandidates(rows) {
  return rows.sort((left, right) => right.score - left.score
    || left.depth - right.depth
    || left.id.localeCompare(right.id)
    || left.generation_id.localeCompare(right.generation_id));
}

export function resolveGraphSeeds(vault, input = {}) {
  if (!vault?.db || typeof vault.dependencies !== "function") throw new Error("vault must provide graph storage and authorization");
  const terms = queryTerms(input.query);
  const scope = authorizedScope(vault, input);
  if (!terms.length || !scope.generations.length) return [];
  const limit = Math.min(100, Math.max(1, Number(input.seed_limit ?? 40)));
  const policy = nodePolicy(scope, input, "n");
  const exact = vault.db.prepare(`
    SELECT n.*
    FROM graph_nodes n
    WHERE ${policy.sql}
      AND EXISTS (
        SELECT 1 FROM json_each(?) term
        WHERE lower(n.id) = term.value
           OR lower(n.qualified_name) = term.value
           OR lower(n.qualified_name) LIKE '%.' || replace(replace(term.value, '%', '\\%'), '_', '\\_') ESCAPE '\\'
           OR lower(n.label) = term.value
           OR lower(n.repo_path) = term.value
           OR lower(n.repo_path) LIKE '%/' || replace(replace(term.value, '%', '\\%'), '_', '\\_') ESCAPE '\\'
      )
    ORDER BY n.qualified_name, n.id, n.generation_id
    LIMIT ?
  `).all(...policy.values, JSON.stringify(terms), limit).map((row) => {
    const normalized = publicNode(vault, row);
    const fields = [normalized.id, normalized.qualified_name, normalized.label, normalized.repo_path]
      .map((value) => String(value || "").toLowerCase());
    const strength = terms.reduce((best, term) => {
      const exactField = fields.includes(term);
      const qualifiedSuffix = fields[1].endsWith(`.${term}`);
      const pathSuffix = fields[3].endsWith(`/${term}`);
      return Math.max(best, exactField ? 1 : (qualifiedSuffix || pathSuffix) ? 0.96 : 0);
    }, 0.9);
    return { ...normalized, seed_match: "exact", score: strength, depth: 0, graph_path: [] };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (exact.length) return exact;
  // A qualified name or repository path is an identity lookup. Falling back to
  // token-level FTS after that identity was denied can return a sibling merely
  // because it shares a package/path prefix, obscuring the fail-closed result
  // and creating a policy oracle. Natural-language queries still use FTS.
  if (terms.some((term) => /[./:#]/.test(term))) return [];
  const fts = ftsExpression(terms);
  if (!fts) return exact;
  const lexicalPolicy = nodePolicy(scope, input, "n");
  return vault.db.prepare(`
    SELECT n.*, bm25(graph_node_fts, 0.0, 0.0, 0.0, 8.0, 5.0, 3.0) AS lexical_rank
    FROM graph_node_fts
    JOIN graph_nodes n
      ON n.tenant_id = graph_node_fts.tenant_id
     AND n.generation_id = graph_node_fts.generation_id
     AND n.id = graph_node_fts.node_id
    WHERE graph_node_fts MATCH ? AND ${lexicalPolicy.sql}
    ORDER BY lexical_rank, n.id, n.generation_id
    LIMIT ?
  `).all(fts, ...lexicalPolicy.values, limit).map((row, index) => ({
    ...publicNode(vault, row), seed_match: "fts", score: 0.72 / (1 + index * 0.03), depth: 0, graph_path: [],
  }));
}

const ENDPOINT_FIELDS = [
  "generation_id", "id", "owner_id", "project_id", "namespace_id", "sensitivity",
  "repo_path", "kind", "qualified_name", "label", "branch", "commit", "language",
  "start_line", "start_column", "end_line", "end_column", "provenance",
  "valid_from", "valid_to", "expires_at", "stale", "excerpt", "memory_id",
];

function endpointSelect(alias, prefix) {
  return ENDPOINT_FIELDS.map((field) => `${alias}.${field === "commit" ? '"commit"' : field} AS ${prefix}_${field}`).join(",\n      ");
}

export function authorizedGraphEdges(vault, scope, input, endpointKeys) {
  if (!endpointKeys.length || !scope.generations.length) return [];
  const keys = endpointKeys.map((value) => typeof value === "string" ? value : `${value.generation_id}\0${value.id}`);
  const edge = edgePolicy(scope, input, "e");
  const source = nodePolicy(scope, input, "source");
  const target = nodePolicy(scope, input, "target");
  return vault.db.prepare(`
    SELECT e.*,
      ${endpointSelect("source", "source")},
      ${endpointSelect("target", "target")}
    FROM graph_edges e
    JOIN graph_nodes source
      ON source.tenant_id = e.tenant_id
     AND source.generation_id = e.source_generation_id
     AND source.id = e.source_id
    JOIN graph_nodes target
      ON target.tenant_id = e.tenant_id
     AND target.generation_id = e.target_generation_id
     AND target.id = e.target_id
    WHERE ${edge.sql}
      AND ${source.sql}
      AND ${target.sql}
      AND ((e.source_generation_id || char(0) || e.source_id) IN (SELECT value FROM json_each(?))
        OR (e.target_generation_id || char(0) || e.target_id) IN (SELECT value FROM json_each(?)))
    ORDER BY e.id, e.source_generation_id, e.target_generation_id
  `).all(...edge.values, ...source.values, ...target.values, JSON.stringify(keys), JSON.stringify(keys));
}

function authorizedSeedNodes(vault, scope, input, seeds) {
  if (!seeds.length || !scope.generations.length) return [];
  const requested = new Map(seeds.filter((seed) => typeof seed?.id === "string")
    .map((seed) => [`${seed.generation_id}\0${seed.id}`, seed]));
  if (!requested.size) return [];
  const policy = nodePolicy(scope, input, "n");
  const rows = vault.db.prepare(`
    SELECT n.* FROM graph_nodes n
    WHERE ${policy.sql}
      AND (n.generation_id || char(0) || n.id) IN (SELECT value FROM json_each(?))
    ORDER BY n.id, n.generation_id
  `).all(...policy.values, JSON.stringify([...requested.keys()]));
  return rows.map((row) => {
    const supplied = requested.get(`${row.generation_id}\0${row.id}`);
    return {
      ...publicNode(vault, row),
      seed_match: supplied.seed_match === "exact" ? "exact" : "fts",
      score: Math.max(0, Math.min(1, Number(supplied.score || 0))),
      depth: 0,
      graph_path: [],
    };
  });
}

function citedHop(edge, direction) {
  const hop = {
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
  // Generation and project identity is redundant for the overwhelmingly common
  // intra-generation hop. Preserve it only when needed to make a cross-project
  // citation independently verifiable and keep bounded result envelopes useful.
  if (edge.source_generation_id !== edge.target_generation_id
    || edge.source_project_id !== edge.target_project_id) {
    hop.source_generation_id = edge.source_generation_id;
    hop.source_project_id = edge.source_project_id;
    hop.target_generation_id = edge.target_generation_id;
    hop.target_project_id = edge.target_project_id;
  }
  return hop;
}

function endpointFromEdge(edge, prefix, direction) {
  return {
    id: edge[`${prefix}_id`],
    memory_id: edge[`${prefix}_memory_id`] || null,
    generation_id: edge[`${prefix}_generation_id`],
    owner_id: edge[`${prefix}_owner_id`],
    project_id: edge[`${prefix}_project_id`],
    namespace_id: edge[`${prefix}_namespace_id`],
    sensitivity: edge[`${prefix}_sensitivity`],
    qualified_name: edge[`${prefix}_qualified_name`],
    label: edge[`${prefix}_label`],
    kind: edge[`${prefix}_kind`],
    repo_path: edge[`${prefix}_repo_path`],
    branch: edge[`${prefix}_branch`] || null,
    commit: edge[`${prefix}_commit`],
    language: edge[`${prefix}_language`],
    start_line: edge[`${prefix}_start_line`],
    start_column: edge[`${prefix}_start_column`],
    end_line: edge[`${prefix}_end_line`],
    end_column: edge[`${prefix}_end_column`],
    provenance: edge[`${prefix}_provenance`],
    valid_from: edge[`${prefix}_valid_from`],
    valid_to: edge[`${prefix}_valid_to`],
    stale: Boolean(edge[`${prefix}_stale`]),
    excerpt: edge[`${prefix}_excerpt`],
    direction,
  };
}

function neighborFromEdge(edge, current, direction) {
  if ((direction === "outgoing" || direction === "both")
    && edge.source_id === current.id && edge.source_generation_id === current.generation_id) {
    return endpointFromEdge(edge, "target", "outgoing");
  }
  if ((direction === "incoming" || direction === "both")
    && edge.target_id === current.id && edge.target_generation_id === current.generation_id) {
    return endpointFromEdge(edge, "source", "incoming");
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

function endpointKey(node) {
  return `${node.generation_id}\0${node.id}`;
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
  let frontier = seeds.slice(0, budgets.maxVisited);
  const visited = new Map(frontier.map((seed) => [endpointKey(seed), seed.score]));
  const candidates = stableCandidates(frontier.map((seed) => ({ ...seed, depth: 0, graph_path: seed.graph_path || [] })))
    .slice(0, budgets.maxPaths);
  let depth = 0;
  while (frontier.length && depth < budgets.depth && visited.size < budgets.maxVisited && candidates.length < budgets.maxPaths) {
    const frontierByKey = new Map(frontier.map((item) => [endpointKey(item), item]));
    const edges = authorizedGraphEdges(vault, scope, input, frontier);
    const nextByKey = new Map();
    for (const edge of edges) {
      for (const currentKey of [
        `${edge.source_generation_id}\0${edge.source_id}`,
        `${edge.target_generation_id}\0${edge.target_id}`,
      ]) {
        const current = frontierByKey.get(currentKey);
        if (!current) continue;
        const neighbor = neighborFromEdge(edge, current, direction);
        if (!neighbor || endpointKey(neighbor) === currentKey) continue;
        const hop = depth + 1;
        const score = current.score
          * (RELATION_SCORE[edge.relation] ?? 0.6)
          * (PROVENANCE_SCORE[edge.provenance] ?? 0)
          * Number(edge.weight)
          * (0.82 ** hop);
        const key = endpointKey(neighbor);
        if (score <= (visited.get(key) ?? Number.NEGATIVE_INFINITY)) continue;
        const candidate = {
          ...neighbor,
          seed_match: current.seed_match,
          score,
          depth: hop,
          graph_path: [...current.graph_path, citedHop(edge, neighbor.direction)],
        };
        const prior = nextByKey.get(key);
        if (!prior || score > prior.score
          || (score === prior.score && JSON.stringify(candidate.graph_path) < JSON.stringify(prior.graph_path))) {
          nextByKey.set(key, candidate);
        }
      }
    }
    const next = stableCandidates([...nextByKey.values()]);
    frontier = [];
    for (const candidate of next) {
      if (visited.size >= budgets.maxVisited || candidates.length >= budgets.maxPaths) break;
      visited.set(endpointKey(candidate), candidate.score);
      frontier.push(candidate);
      candidates.push(candidate);
    }
    depth += 1;
  }
  return stableCandidates(candidates).slice(0, budgets.maxPaths);
}

export function evaluateGraphCoverage({ query = "", seeds = [], candidates = [], minimum_candidates = 1, minimum_path_score = 0.2 } = {}) {
  const exactSeeds = seeds.filter((seed) => seed.seed_match === "exact");
  const evidenceCandidates = candidates.filter((candidate) => (
    Number(candidate.depth || 0) > 0 && Array.isArray(candidate.graph_path) && candidate.graph_path.length > 0
  ));
  const bestPathScore = evidenceCandidates.reduce((best, candidate) => Math.max(best, Number(candidate.score || 0)), 0);
  let fallbackReason = null;
  if (!seeds.length) fallbackReason = "no_seed";
  else if (evidenceCandidates.length < Math.max(1, Number(minimum_candidates))) fallbackReason = "insufficient_candidates";
  else if (bestPathScore < Number(minimum_path_score)) fallbackReason = "low_path_confidence";
  else if (!exactSeeds.length && query.trim().split(/\s+/).length >= 5) fallbackReason = "conceptual_query";
  return {
    sufficient: fallbackReason === null,
    should_fallback: fallbackReason !== null,
    fallback_reason: fallbackReason,
    seed_count: seeds.length,
    exact_seed_count: exactSeeds.length,
    candidate_count: evidenceCandidates.length,
    best_path_score: bestPathScore,
  };
}

export function graphGenerationSummary(vault, input, { limit = 20 } = {}) {
  const boundedLimit = Math.min(20, Math.max(1, Number.isInteger(limit) ? limit : 20));
  const generations = authorizedScope(vault, input).generations
    .map(({ id, project_id, branch, commit, valid_from, valid_to }) => ({
      id, project_id, branch, commit, valid_from, valid_to,
    }))
    .sort((left, right) => left.project_id.localeCompare(right.project_id) || left.id.localeCompare(right.id));
  if (!generations.length) return null;
  if (generations.length === 1) return generations[0];
  return {
    generations: generations.slice(0, boundedLimit),
    total_count: generations.length,
    truncated: generations.length > boundedLimit,
  };
}
