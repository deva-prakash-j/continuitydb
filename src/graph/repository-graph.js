import { execFileSync } from "node:child_process";
import { readCommittedSnapshot } from "../repo-ingest.js";
import { graphEdgeId } from "./model.js";
import { extractJavaSpring } from "./java-spring-extractor.js";
import { extractStructuredGraph } from "./structured-extractors.js";

export const REPOSITORY_GRAPH_EXTRACTOR_VERSION = "repository-graph-v2";

function extractorFor(repoPath) {
  if (repoPath.endsWith(".java")) return extractJavaSpring;
  const name = repoPath.split("/").at(-1).toLowerCase();
  if (name === "pom.xml" || name.endsWith(".gradle") || name.endsWith(".gradle.kts")
    || name.endsWith(".yml") || name.endsWith(".yaml") || name.endsWith(".json")
    || name.endsWith(".md") || name.endsWith(".markdown")) return extractStructuredGraph;
  return null;
}

function activeProjection(vault, scope) {
  const allowedProjects = vault.db.prepare(`
    SELECT DISTINCT project_id FROM graph_generations
    WHERE tenant_id = ? AND owner_id = ? AND branch = ? AND status = 'active'
      AND sensitivity = ? AND lifecycle_status = 'active' AND stale = 0
    ORDER BY project_id
  `).all(scope.tenant_id, scope.owner_id, scope.branch || "", scope.sensitivity)
    .map((row) => row.project_id);
  if (!allowedProjects.includes(scope.project_id)) allowedProjects.push(scope.project_id);
  const projection = vault.activeGraphProjection({
    ...scope,
    allowed_projects: allowedProjects,
    allowed_namespaces: allowedProjects.map((projectId) => `project/${projectId}`),
    allowed_sensitivities: [scope.sensitivity],
  });
  const sourceStates = new Map(projection.source_states.map((row) => [row.repo_path, row]));
  const nodesByPath = new Map();
  const nodesById = new Map();
  const memoryNodeIds = new Set(projection.nodes.filter((node) => node.memory_id).map((node) => node.id));
  for (const node of projection.nodes) {
    if (node.memory_id) continue;
    const nodes = nodesByPath.get(node.repo_path) || [];
    nodes.push(node); nodesByPath.set(node.repo_path, nodes);
    nodesById.set(node.id, node);
  }
  const edgesByPath = new Map();
  for (const edge of projection.edges) {
    if (memoryNodeIds.has(edge.source_id) || memoryNodeIds.has(edge.target_id)) continue;
    const reusable = {
      ...edge,
      source_generation_id: edge.source_generation_id === projection.generation?.id ? null : edge.source_generation_id,
      target_generation_id: edge.target_generation_id === projection.generation?.id ? null : edge.target_generation_id,
    };
    const edges = edgesByPath.get(edge.repo_path) || [];
    edges.push(reusable); edgesByPath.set(edge.repo_path, edges);
  }
  const edges = [...edgesByPath.values()].flat();
  const crossGenerationPaths = new Set(projection.generation ? vault.db.prepare(`
    SELECT repo_path FROM graph_edges
    WHERE tenant_id = ? AND generation_id = ?
      AND (source_generation_id != generation_id OR target_generation_id != generation_id)
      AND repo_path IS NOT NULL
  `).all(scope.tenant_id, projection.generation.id).map((row) => row.repo_path) : []);
  return {
    generation: projection.generation,
    sourceStates,
    nodesByPath,
    nodesById,
    edgesByPath,
    edges,
    crossGenerationPaths,
  };
}

// Extractors deliberately emit unresolved placeholders when they only see one
// file. Once all file projections are assembled, replace those placeholders
// with a concrete declaration from another file where one exists.
function resolveCrossFileEdges(vault, scope, nodes, edges) {
  const declarations = new Map();
  for (const node of nodes) {
    if (node.provenance === "resolved") continue;
    const key = node.qualified_name;
    const choices = declarations.get(key) || [];
    choices.push(node); declarations.set(key, choices);
  }
  const replacements = new Map();
  for (const node of nodes) {
    if (node.provenance !== "resolved") continue;
    const target = (declarations.get(node.qualified_name) || [])
      .find((candidate) => candidate.repo_path !== node.repo_path);
    if (target) replacements.set(node.id, { id: target.id, generation_id: null, external: false });
  }
  const external = vault.db.prepare(`
    SELECT n.id, n.qualified_name, n.kind, n.generation_id
    FROM graph_nodes n
    JOIN graph_generations g ON g.id = n.generation_id AND g.tenant_id = n.tenant_id
    WHERE n.tenant_id = ? AND n.owner_id = ? AND g.status = 'active'
      AND g.project_id != ? AND g.branch = ?
      AND n.lifecycle_status = 'active' AND n.stale = 0
      AND n.sensitivity = ?
    ORDER BY n.qualified_name, n.project_id, n.id
  `).all(scope.tenant_id, scope.owner_id, scope.project_id, scope.branch || "", scope.sensitivity);
  const externalByName = new Map();
  const externalById = new Map();
  for (const candidate of external) {
    if (!externalByName.has(candidate.qualified_name)) externalByName.set(candidate.qualified_name, candidate);
    externalById.set(candidate.id, candidate);
  }
  for (const node of nodes) {
    if (replacements.has(node.id)) continue;
    if (node.provenance !== "resolved" && node.kind !== "dependency") continue;
    const target = externalByName.get(node.qualified_name);
    if (target && (node.kind !== "dependency" || target.kind === "module")) {
      replacements.set(node.id, { id: target.id, generation_id: target.generation_id, external: true });
    }
  }
  const keptNodes = nodes.filter((node) => !replacements.has(node.id));
  const keptIds = new Set(keptNodes.map((node) => node.id));
  const unique = new Map();
  for (const edge of edges) {
    const sourceReplacement = replacements.get(edge.source_id);
    const targetReplacement = replacements.get(edge.target_id);
    const source_id = sourceReplacement?.id || edge.source_id;
    const target_id = targetReplacement?.id || edge.target_id;
    const sourceExternal = sourceReplacement?.generation_id
      ? sourceReplacement
      : !keptIds.has(source_id) ? externalById.get(source_id) : null;
    const targetExternal = targetReplacement?.generation_id
      ? targetReplacement
      : !keptIds.has(target_id) ? externalById.get(target_id) : null;
    if (!keptIds.has(source_id) && !sourceExternal) continue;
    if (!keptIds.has(target_id) && !targetExternal) continue;
    const resolved = {
      ...edge,
      source_id,
      target_id,
      source_generation_id: sourceExternal?.generation_id || null,
      target_generation_id: targetExternal?.generation_id || null,
      provenance: sourceReplacement?.external || targetReplacement?.external ? "resolved" : edge.provenance,
    };
    resolved.id = graphEdgeId(resolved);
    unique.set(resolved.id, resolved);
  }
  return { nodes: keptNodes, edges: [...unique.values()] };
}

function copied(items, commit) {
  return (items || []).map((item) => ({ ...item, commit }));
}

/**
 * Builds a complete, atomic graph generation from the repository's HEAD tree.
 * No database mutation occurs until publishGraph receives the normalized,
 * combined projection, so an interrupted extraction leaves active retrieval
 * untouched.
 */
export function buildRepositoryGraph(vault, inputPath, options = {}) {
  if (!vault || typeof vault.publishGraph !== "function" || typeof vault.activeGraphProjection !== "function") {
    throw new Error("vault must provide graph publication APIs");
  }
  // `since` is a parsing hint, never a snapshot boundary. Publication always
  // evaluates the complete committed HEAD tree so unchanged files cannot be
  // mistaken for removals.
  const snapshot = readCommittedSnapshot(inputPath, { ...options, since: null });
  const snapshotDiagnostics = {
    truncated: snapshot.truncated,
    scanned_files: snapshot.scanned_files,
    skipped: { ...snapshot.skipped },
  };
  if (snapshot.truncated || snapshot.skipped.too_large > 0 || snapshot.skipped.unreadable > 0) {
    const error = new Error("repository graph snapshot is incomplete and cannot be published");
    error.code = "INCOMPLETE_GRAPH_SNAPSHOT";
    error.diagnostics = snapshotDiagnostics;
    throw error;
  }
  const project_id = options.projectId || snapshot.repository.project_id;
  const tenant_id = options.tenantId ?? options.tenant_id ?? "local";
  const owner_id = options.ownerId ?? options.owner_id ?? "local-user";
  const namespace_id = options.namespaceId ?? options.namespace_id ?? `project/${project_id}`;
  const sensitivity = options.sensitivity ?? "private";
  const extractor_version = options.extractorVersion ?? options.extractor_version ?? REPOSITORY_GRAPH_EXTRACTOR_VERSION;
  const scope = { tenant_id, owner_id, project_id, namespace_id, sensitivity, branch: snapshot.repository.branch };
  const prior = activeProjection(vault, scope);
  const candidates = snapshot.files.map((file) => ({ file, extractor: extractorFor(file.repo_path) }));
  const graphPaths = new Set(candidates.filter(({ extractor }) => extractor).map(({ file }) => file.repo_path));
  const pathsToParse = new Set();
  for (const { file, extractor } of candidates) {
    if (!extractor) continue;
    const old = prior.sourceStates.get(file.repo_path);
    if (!old || old.git_object_id !== file.git_object_id || old.extractor_version !== extractor_version) {
      pathsToParse.add(file.repo_path);
    }
  }
  // Cross-generation targets can be superseded independently. Reparse their
  // referring source on each build so the edge is resolved to the currently
  // active authorized target generation instead of silently retaining or
  // dropping an obsolete endpoint.
  for (const repoPath of prior.crossGenerationPaths) {
    if (graphPaths.has(repoPath)) pathsToParse.add(repoPath);
  }
  // A reused source can retain an edge to a declaration in another file. If
  // that target is changed, deleted, or renamed, re-extract the caller so it
  // either resolves to the replacement or emits a safe local placeholder.
  const affectedPaths = new Set([...pathsToParse, ...[...prior.sourceStates.keys()].filter((path) => !graphPaths.has(path))]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of prior.edges) {
      const sourcePath = edge.repo_path || prior.nodesById.get(edge.source_id)?.repo_path;
      const targetPath = prior.nodesById.get(edge.target_id)?.repo_path;
      if (!targetPath || !affectedPaths.has(targetPath) || !graphPaths.has(sourcePath) || affectedPaths.has(sourcePath)) continue;
      affectedPaths.add(sourcePath);
      pathsToParse.add(sourcePath);
      expanded = true;
    }
  }
  const source_states = [];
  const nodes = [];
  const edges = [];
  const diagnostics = { errors: 0, warnings: 0, skipped: 0 };
  let parsed_files = 0;
  let reused_files = 0;
  let unsupported_files = snapshot.skipped.unsupported;

  for (const { file, extractor } of candidates) {
    if (!extractor) { unsupported_files += 1; continue; }
    source_states.push({
      repo_path: file.repo_path,
      git_object_id: file.git_object_id,
      content_hash: file.checksum,
      extractor_version,
    });
    const old = prior.sourceStates.get(file.repo_path);
    if (old && old.git_object_id === file.git_object_id && old.extractor_version === extractor_version && !pathsToParse.has(file.repo_path)) {
      reused_files += 1;
      nodes.push(...copied(prior.nodesByPath.get(file.repo_path), snapshot.repository.commit));
      edges.push(...copied(prior.edgesByPath.get(file.repo_path), snapshot.repository.commit));
      continue;
    }
    parsed_files += 1;
    try {
      const result = extractor({
        tenant_id,
        project_id,
        repo_path: file.repo_path,
        commit: snapshot.repository.commit,
        branch: snapshot.repository.branch,
        text: file.bytes.toString("utf8"),
      });
      diagnostics.errors += result.diagnostics?.errors || 0;
      diagnostics.warnings += result.diagnostics?.warnings || 0;
      diagnostics.skipped += result.diagnostics?.skipped || 0;
      nodes.push(...result.nodes.map((node) => ({ ...node, content_hash: file.checksum })));
      edges.push(...result.edges);
    } catch (error) {
      diagnostics.errors += 1;
      diagnostics.last_error = `${file.repo_path}: ${error.message}`.slice(0, 500);
    }
  }

  if (diagnostics.errors > 0) {
    const error = new Error("repository graph extraction reported errors and cannot be published");
    error.code = "GRAPH_EXTRACTION_FAILED";
    error.diagnostics = { ...diagnostics };
    throw error;
  }

  const currentPaths = new Set(source_states.map((state) => state.repo_path));
  const removed_files = [...prior.sourceStates.keys()].filter((path) => !currentPaths.has(path)).length;
  const resolved = resolveCrossFileEdges(
    vault,
    scope,
    [...new Map(nodes.map((node) => [node.id, node])).values()],
    [...new Map(edges.map((edge) => [edge.id, edge])).values()],
  );
  const currentHead = execFileSync("git", ["-C", snapshot.repository.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (currentHead !== snapshot.repository.commit) {
    const error = new Error("repository HEAD changed while the graph was being built");
    error.code = "STALE_REPOSITORY_SNAPSHOT";
    error.diagnostics = { expected_commit: snapshot.repository.commit, actual_commit: currentHead };
    throw error;
  }
  const published = vault.publishGraph({
    tenant_id,
    owner_id,
    project_id,
    namespace_id,
    sensitivity,
    branch: snapshot.repository.branch,
    commit: snapshot.repository.commit,
    valid_from: snapshot.repository.commit_time,
    extractor_version,
    source_states,
    nodes: resolved.nodes,
    edges: resolved.edges,
  }, { expectedActiveGenerationId: prior.generation?.id || null });
  return {
    commit: snapshot.repository.commit,
    generation_id: published.id,
    scanned_files: snapshot.scanned_files,
    parsed_files,
    reused_files,
    denied_files: snapshot.skipped.denied,
    unsupported_files,
    removed_files,
    nodes: resolved.nodes.length,
    edges: resolved.edges.length,
    diagnostics,
    snapshot_diagnostics: snapshotDiagnostics,
  };
}
