import { graphEdgeId, graphNodeId, normalizeGraphPath } from "./model.js";
import { requiredIdentifier } from "../security.js";

const EXTRACTOR_VERSION = "structured-v1";
const SECRET_KEY = /(?:pass(?:word)?|secret|token|api[-_]?key|credential|private[-_]?key|authorization|auth)/i;
const MAX_TEXT = 2 * 1024 * 1024;

function scopeFor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extractor input must be an object");
  const tenant_id = requiredIdentifier(input.tenantId ?? input.tenant_id, "tenant_id");
  const project_id = requiredIdentifier(input.projectId ?? input.project_id, "project_id");
  const repo_path = normalizeGraphPath(input.repoPath ?? input.repo_path);
  if (typeof input.commit !== "string" || !input.commit.trim()) throw new Error("commit must be a non-empty string");
  const branch = input.branch === undefined || input.branch === null || input.branch === "" ? null : requiredIdentifier(input.branch, "branch");
  if (typeof input.text !== "string") throw new Error("text must be a string");
  return { tenant_id, project_id, repo_path, commit: input.commit.trim(), branch };
}

function empty(errors = 0, warnings = 0, skipped = 0) {
  return { nodes: [], edges: [], diagnostics: { errors, warnings, skipped } };
}

function isSecret(parts) { return parts.some((part) => SECRET_KEY.test(part)); }

function maskXmlComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function maskGradleComments(text) {
  const chars = [...text]; let quote = null;
  for (let index = 0; index < chars.length;) {
    if (quote) {
      if (chars[index] === "\\") { index += 2; continue; }
      if (chars[index] === quote) quote = null;
      index += 1; continue;
    }
    if (chars[index] === "'" || chars[index] === '"') { quote = chars[index]; index += 1; continue; }
    if (chars[index] === "/" && chars[index + 1] === "/") {
      const start = index; index += 2;
      while (index < chars.length && chars[index] !== "\n") index += 1;
      for (let cursor = start; cursor < index; cursor += 1) chars[cursor] = " ";
      continue;
    }
    if (chars[index] === "/" && chars[index + 1] === "*") {
      const start = index; index += 2;
      while (index < chars.length && !(chars[index] === "*" && chars[index + 1] === "/")) index += 1;
      index = Math.min(chars.length, index + 2);
      for (let cursor = start; cursor < index; cursor += 1) if (chars[cursor] !== "\n") chars[cursor] = " ";
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

function graphBuilder(scope, language) {
  const nodes = new Map(); const edges = [];
  const addNode = (kind, qualified_name, { line = null, summary = undefined } = {}) => {
    const identity = { ...scope, kind, qualified_name };
    const id = graphNodeId(identity);
    if (!nodes.has(id)) {
      const node = {
        ...identity, id, label: qualified_name, language, provenance: "extracted",
        start_line: line, start_column: line === null ? null : 1,
        end_line: line, end_column: line === null ? null : 1,
        extractor_version: EXTRACTOR_VERSION,
      };
      if (summary) node.summary = summary.slice(0, 280);
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const file = addNode("file", scope.repo_path);
  const addEdge = (source, target, relation, line = null) => {
    const edge = {
      source_id: source.id, target_id: target.id, relation, repo_path: scope.repo_path,
      start_line: line, start_column: line === null ? null : 1,
      end_line: line, end_column: line === null ? null : 1,
      provenance: "extracted", commit: scope.commit, extractor_version: EXTRACTOR_VERSION,
      source, target,
    };
    edge.id = graphEdgeId(edge); edges.push(edge);
  };
  return {
    file, addNode, addEdge,
    finish(diagnostics = { errors: 0, warnings: 0, skipped: 0 }) {
      const distinctEdges = [...new Map(edges.map((edge) => [edge.id, edge])).values()];
      distinctEdges.sort((left, right) => left.relation.localeCompare(right.relation)
        || nodes.get(left.source_id).qualified_name.localeCompare(nodes.get(right.source_id).qualified_name)
        || nodes.get(left.target_id).qualified_name.localeCompare(nodes.get(right.target_id).qualified_name));
      return {
        nodes: [...nodes.values()].sort((left, right) => left.qualified_name.localeCompare(right.qualified_name) || left.kind.localeCompare(right.kind)),
        edges: distinctEdges,
        diagnostics,
      };
    },
  };
}

function extractPom(scope, text) {
  const masked = maskXmlComments(text);
  if (!/<project(?:\s|>)/.test(masked) || !/<\/project\s*>/.test(masked)) return empty(1);
  const graph = graphBuilder(scope, "xml");
  const dependency = /<dependency(?:\s[^>]*)?>([\s\S]*?)<\/dependency\s*>/g;
  let match; let line = 1;
  while ((match = dependency.exec(masked))) {
    const group = match[1].match(/<groupId\s*>([^<\s]+)<\/groupId\s*>/)?.[1];
    const artifact = match[1].match(/<artifactId\s*>([^<\s]+)<\/artifactId\s*>/)?.[1];
    if (!group || !artifact || /[@/\\]/.test(group) || /[@/\\]/.test(artifact)) continue;
    line = masked.slice(0, match.index).split("\n").length;
    graph.addEdge(graph.file, graph.addNode("dependency", `${group}:${artifact}`, { line }), "depends-on", line);
  }
  return graph.finish();
}

function extractGradle(scope, text) {
  const masked = maskGradleComments(text);
  let quote = null;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === "\\") { index += 1; continue; }
    if ((masked[index] === "'" || masked[index] === '"') && (!quote || quote === masked[index])) quote = quote ? null : masked[index];
  }
  if (quote || (masked.match(/\(/g)?.length || 0) !== (masked.match(/\)/g)?.length || 0)) return empty(1);
  const graph = graphBuilder(scope, "gradle");
  const notation = /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(\s*)?["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::[^"']+)?["']\s*\)?/g;
  let match;
  while ((match = notation.exec(masked))) {
    const line = masked.slice(0, match.index).split("\n").length;
    graph.addEdge(graph.file, graph.addNode("dependency", `${match[1]}:${match[2]}`, { line }), "depends-on", line);
  }
  return graph.finish();
}

function extractYaml(scope, text) {
  const graph = graphBuilder(scope, "yaml");
  const stack = []; const lines = text.split(/\r?\n/); let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]; if (!raw.trim() || raw.trimStart().startsWith("#") || raw.trim() === "---") continue;
    if (/\t/.test(raw)) return empty(1, 0, skipped);
    const match = raw.match(/^( *)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(.*)$/);
    if (!match) return empty(1, 0, skipped);
    const indent = match[1].length; const key = match[2] ?? match[3] ?? match[4]; const value = match[5];
    if ((value.includes("[") && !value.includes("]")) || (value.includes("{") && !value.includes("}")) || (/^['"]/.test(value) && !value.endsWith(value[0]))) return empty(1, 0, skipped);
    while (stack.length && indent <= stack.at(-1).indent) stack.pop();
    const parts = [...stack.map((entry) => entry.key), key];
    const denied = stack.at(-1)?.denied || isSecret(parts);
    if (denied) {
      skipped += 1;
      if (!value.trim()) stack.push({ indent, key, denied: true });
      continue;
    }
    if (value.trim()) {
      const qualified = parts.join("."); const node = graph.addNode("configuration-key", qualified, { line: index + 1 });
      graph.addEdge(graph.file, node, "declares", index + 1);
    } else stack.push({ indent, key, denied: false });
  }
  return graph.finish({ errors: 0, warnings: 0, skipped });
}

function pointerPart(key) { return key.replaceAll("~", "~0").replaceAll("/", "~1"); }
function extractJson(scope, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return empty(1); }
  if (!parsed || typeof parsed !== "object") return empty(1);
  const graph = graphBuilder(scope, "json"); let skipped = 0;
  const visit = (value, parts) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...parts, key];
      if (isSecret(next)) { skipped += 1; continue; }
      const pointer = `/${next.map(pointerPart).join("/")}`;
      const node = graph.addNode("configuration-key", pointer);
      graph.addEdge(graph.file, node, "declares");
      visit(child, next);
    }
  };
  visit(parsed, []);
  return graph.finish({ errors: 0, warnings: 0, skipped });
}

function extractMarkdown(scope, text) {
  const graph = graphBuilder(scope, "markdown");
  const title = scope.repo_path.split("/").at(-1).replace(/\.[^.]+$/, "");
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)];
  headings.forEach((match, index) => {
    const heading = match[2].trim(); const start = match.index + match[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    if (SECRET_KEY.test(heading)) return;
    const summary = text.slice(start, end).split(/\r?\n/)
      .map((line) => line.trim()).filter((line) => line && !SECRET_KEY.test(line) && !/\b(?:password|token|secret)\s*[:=]/i.test(line))
      .join(" ").slice(0, 280);
    const line = text.slice(0, match.index).split("\n").length;
    const section = graph.addNode("document-section", `${title}#${heading}`, { line, summary });
    graph.addEdge(graph.file, section, "documents", line);
  });
  return graph.finish();
}

export function extractStructuredGraph(input) {
  const scope = scopeFor(input);
  if (input.text.length > MAX_TEXT) return empty(1);
  const name = scope.repo_path.split("/").at(-1).toLowerCase();
  if (name === "pom.xml") return extractPom(scope, input.text);
  if (name.endsWith(".gradle") || name.endsWith(".gradle.kts")) return extractGradle(scope, input.text);
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return extractYaml(scope, input.text);
  if (name.endsWith(".json")) return extractJson(scope, input.text);
  if (name.endsWith(".md") || name.endsWith(".markdown")) return extractMarkdown(scope, input.text);
  return empty(0, 0, 1);
}
