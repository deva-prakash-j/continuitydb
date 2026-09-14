import { readCommittedSnapshot } from "../repo-ingest.js";
import { graphEdgeId } from "./model.js";
import { extractJavaSpring } from "./java-spring-extractor.js";
import { extractStructuredGraph } from "./structured-extractors.js";

export const REPOSITORY_GRAPH_EXTRACTOR_VERSION = "repository-graph-v1";

function extractorFor(repoPath) {
  if (repoPath.endsWith(".java")) return extractJavaSpring;
  const name = repoPath.split("/").at(-1).toLowerCase();
  if (name === "pom.xml" || name.endsWith(".gradle") || name.endsWith(".gradle.kts")
    || name.endsWith(".yml") || name.endsWith(".yaml") || name.endsWith(".json")
    || name.endsWith(".md") || name.endsWith(".markdown")) return extractStructuredGraph;
  return null;
}

function activeProjection(vault, scope) {
  const generation = vault.activeGraphGeneration(scope);
  if (!generation) return { generation: null, sourceStates: new Map(), nodesByPath: new Map(), edgesByPath: new Map() };
  if (!vault?.db?.prepare) throw new Error("vault must expose graph source state storage");
  const sourceStates = new Map(vault.db.prepare(`
    SELECT repo_path, git_object_id, content_hash, extractor_version
    FROM graph_source_states WHERE tenant_id = ? AND generation_id = ?
  `).all(generation.tenant_id, generation.id).map((row) => [row.repo_path, row]));
  const nodesByPath = new Map();
  for (const node of vault.db.prepare(`SELECT * FROM graph_nodes WHERE tenant_id = ? AND generation_id = ?`).all(generation.tenant_id, generation.id)) {
    const nodes = nodesByPath.get(node.repo_path) || [];
    nodes.push(node); nodesByPath.set(node.repo_path, nodes);
  }
  const edgesByPath = new Map();
  for (const edge of vault.db.prepare(`SELECT * FROM graph_edges WHERE tenant_id = ? AND generation_id = ?`).all(generation.tenant_id, generation.id)) {
    const edges = edgesByPath.get(edge.repo_path) || [];
    edges.push(edge); edgesByPath.set(edge.repo_path, edges);
  }
  return { generation, sourceStates, nodesByPath, edgesByPath };
}

// Extractors deliberately emit unresolved placeholders when they only see one
// file. Once all file projections are assembled, replace those placeholders
// with a concrete declaration from another file where one exists.
function resolveCrossFileEdges(nodes, edges) {
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
    if (target) replacements.set(node.id, target.id);
  }
  const keptNodes = nodes.filter((node) => !replacements.has(node.id));
  const keptIds = new Set(keptNodes.map((node) => node.id));
  const unique = new Map();
  for (const edge of edges) {
    const source_id = replacements.get(edge.source_id) || edge.source_id;
    const target_id = replacements.get(edge.target_id) || edge.target_id;
    if (!keptIds.has(source_id) || !keptIds.has(target_id)) continue;
    const resolved = { ...edge, source_id, target_id };
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
  if (!vault || typeof vault.publishGraph !== "function" || typeof vault.activeGraphGeneration !== "function") {
    throw new Error("vault must provide graph publication APIs");
  }
  const snapshot = readCommittedSnapshot(inputPath, options);
  const project_id = options.projectId || snapshot.repository.project_id;
  const tenant_id = options.tenantId ?? options.tenant_id ?? "local";
  const extractor_version = options.extractorVersion ?? options.extractor_version ?? REPOSITORY_GRAPH_EXTRACTOR_VERSION;
  const scope = { tenant_id, project_id, branch: snapshot.repository.branch };
  const prior = activeProjection(vault, scope);
  const source_states = [];
  const nodes = [];
  const edges = [];
  const diagnostics = { errors: 0, warnings: 0, skipped: 0 };
  let parsed_files = 0;
  let reused_files = 0;
  let unsupported_files = snapshot.skipped.unsupported;

  for (const file of snapshot.files) {
    const extractor = extractorFor(file.repo_path);
    if (!extractor) { unsupported_files += 1; continue; }
    source_states.push({
      repo_path: file.repo_path,
      git_object_id: file.git_object_id,
      content_hash: file.checksum,
      extractor_version,
    });
    const old = prior.sourceStates.get(file.repo_path);
    if (old && old.git_object_id === file.git_object_id && old.extractor_version === extractor_version) {
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
    } catch {
      diagnostics.errors += 1;
    }
  }

  const currentPaths = new Set(source_states.map((state) => state.repo_path));
  const removed_files = [...prior.sourceStates.keys()].filter((path) => !currentPaths.has(path)).length;
  const resolved = resolveCrossFileEdges(
    [...new Map(nodes.map((node) => [node.id, node])).values()],
    [...new Map(edges.map((edge) => [edge.id, edge])).values()],
  );
  const published = vault.publishGraph({
    tenant_id,
    project_id,
    branch: snapshot.repository.branch,
    commit: snapshot.repository.commit,
    extractor_version,
    source_states,
    nodes: resolved.nodes,
    edges: resolved.edges,
  });
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
  };
}
