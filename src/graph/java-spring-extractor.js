import { graphEdgeId, graphNodeId, normalizeGraphPath } from "./model.js";
import { requiredIdentifier } from "../security.js";

const EXTRACTOR_VERSION = "java-spring-v1";
const TYPE_WORDS = new Set(["class", "interface", "enum", "record"]);
const MODIFIERS = new Set(["public", "private", "protected", "static", "final", "abstract", "default", "synchronized", "native", "strictfp", "sealed", "non-sealed", "volatile", "transient"]);

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

// Retains newlines and quote positions so token offsets remain source offsets. String
// payload is carried only by a string token and never re-tokenized as Java source.
function maskJava(text) {
  const chars = [...text];
  for (let index = 0; index < chars.length;) {
    if (chars[index] === "/" && chars[index + 1] === "/") {
      const start = index; index += 2;
      while (index < chars.length && chars[index] !== "\n") index += 1;
      for (let cursor = start; cursor < index; cursor += 1) chars[cursor] = " ";
    } else if (chars[index] === "/" && chars[index + 1] === "*") {
      const start = index; index += 2;
      while (index < chars.length && !(chars[index] === "*" && chars[index + 1] === "/")) index += 1;
      index = Math.min(chars.length, index + 2);
      for (let cursor = start; cursor < index; cursor += 1) if (chars[cursor] !== "\n") chars[cursor] = " ";
    } else if (chars[index] === '"' || chars[index] === "'") {
      const quote = chars[index];
      const start = index; index += 1;
      while (index < chars.length) {
        if (chars[index] === "\\") { index += 2; continue; }
        if (chars[index] === quote) { index += 1; break; }
        index += 1;
      }
      for (let cursor = start + 1; cursor < index - 1; cursor += 1) if (chars[cursor] !== "\n") chars[cursor] = " ";
    } else index += 1;
  }
  return chars.join("");
}

export function tokenizeJava(text) {
  const masked = maskJava(text);
  const tokens = [];
  let line = 1; let column = 1;
  for (let index = 0; index < masked.length;) {
    const char = masked[index];
    if (/\s/.test(char)) {
      if (char === "\n") { line += 1; column = 1; } else column += 1;
      index += 1; continue;
    }
    const start = index; const startLine = line; const startColumn = column;
    if (char === '"' || char === "'") {
      const quote = char; index += 1;
      while (index < masked.length && masked[index] !== quote) index += 1;
      if (index < masked.length) index += 1;
      const value = text.slice(start + 1, Math.max(start + 1, index - 1));
      tokens.push({ type: "string", value, start, end: index, line: startLine, column: startColumn });
      column += index - start; continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      index += 1; while (index < masked.length && /[A-Za-z0-9_$]/.test(masked[index])) index += 1;
      tokens.push({ type: "identifier", value: masked.slice(start, index), start, end: index, line: startLine, column: startColumn });
    } else {
      index += 1;
      tokens.push({ type: "punctuation", value: char, start, end: index, line: startLine, column: startColumn });
    }
    column += index - start;
  }
  return tokens;
}

function matchingPairs(tokens, open, close) {
  const stack = []; const pairs = new Map();
  tokens.forEach((token, index) => {
    if (token.value === open) stack.push(index);
    else if (token.value === close && stack.length) { const left = stack.pop(); pairs.set(left, index); pairs.set(index, left); }
  });
  return pairs;
}

function dotted(tokens, start, stop = new Set([";"])) {
  const parts = [];
  for (let index = start; index < tokens.length && !stop.has(tokens[index].value); index += 1) {
    if (tokens[index].type === "identifier") parts.push(tokens[index].value);
  }
  return parts.join(".");
}

function arity(tokens, start, end, parens) {
  if (start >= end) return 0;
  let commas = 0; let meaningful = false;
  for (let index = start; index < end; index += 1) {
    if (tokens[index].value === "(" && parens.get(index) < end) { index = parens.get(index); continue; }
    if (tokens[index].value === ",") commas += 1;
    else if (tokens[index].type === "identifier") meaningful = true;
  }
  return meaningful ? commas + 1 : 0;
}

function qualifiedType(name, packageName, imports) {
  if (name.includes(".")) return name;
  return imports.get(name) || (packageName ? `${packageName}.${name}` : name);
}

function annotationFacts(tokens, parens) {
  const annotations = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index].value !== "@" || tokens[index + 1].type !== "identifier") continue;
    let end = index + 1; let args = [];
    if (tokens[end + 1]?.value === "(") {
      const close = parens.get(end + 1);
      if (close !== undefined) { args = tokens.slice(end + 2, close); end = close; }
    }
    annotations.push({ name: tokens[index + 1].value, start: index, end, args, token: tokens[index] });
  }
  return annotations;
}

export function parseJavaStructure(tokens) {
  const braces = matchingPairs(tokens, "{", "}");
  const parens = matchingPairs(tokens, "(", ")");
  let packageName = "";
  const imports = new Map(); const importNames = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === "package") packageName = dotted(tokens, index + 1);
    if (tokens[index].value === "import") {
      const name = dotted(tokens, index + 1);
      if (name) { imports.set(name.split(".").at(-1), name); importNames.push({ name, token: tokens[index] }); }
    }
  }
  const annotations = annotationFacts(tokens, parens);
  const types = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!TYPE_WORDS.has(tokens[index].value) || tokens[index + 1].type !== "identifier") continue;
    const name = tokens[index + 1].value;
    let open = index + 2;
    while (open < tokens.length && tokens[open].value !== "{" && tokens[open].value !== ";") open += 1;
    if (tokens[open]?.value !== "{") continue;
    const close = braces.get(open);
    if (close === undefined) continue;
    const header = tokens.slice(index + 2, open);
    const relations = [];
    for (let cursor = 0; cursor < header.length; cursor += 1) {
      if (header[cursor].value !== "extends" && header[cursor].value !== "implements") continue;
      const relation = header[cursor].value;
      const names = []; let current = [];
      for (cursor += 1; cursor < header.length && header[cursor].value !== "extends" && header[cursor].value !== "implements"; cursor += 1) {
        if (header[cursor].value === ",") { if (current.length) names.push(current.join(".")); current = []; }
        else if (header[cursor].type === "identifier" || header[cursor].value === ".") current.push(header[cursor].value);
      }
      if (current.length) names.push(current.join(".")); cursor -= 1;
      names.filter(Boolean).forEach((target) => relations.push({ relation, target }));
    }
    types.push({ name, kind: tokens[index].value, start: index, open, close, token: tokens[index], relations, methods: [], fields: [] });
  }
  for (const type of types) {
    let depth = 0;
    for (let index = type.open + 1; index < type.close; index += 1) {
      if (tokens[index].value === "{") { depth += 1; continue; }
      if (tokens[index].value === "}") { depth -= 1; continue; }
      if (depth !== 0 || tokens[index].value !== "(" || tokens[index - 1]?.type !== "identifier" || tokens[index - 2]?.value === "@") continue;
      const close = parens.get(index); if (close === undefined) continue;
      let terminator = close + 1;
      while (terminator < type.close && !["{", ";", "="].includes(tokens[terminator].value)) terminator += 1;
      if (tokens[terminator]?.value !== "{" && tokens[terminator]?.value !== ";") continue;
      const name = tokens[index - 1].value;
      if (["if", "for", "while", "switch", "catch", "return", "new"].includes(name)) continue;
      type.methods.push({ name, start: index - 1, open: index, close, end: terminator, bodyClose: tokens[terminator].value === "{" ? braces.get(terminator) : terminator, arity: arity(tokens, index + 1, close, parens), token: tokens[index - 1] });
      if (tokens[terminator].value === "{") index = terminator - 1;
    }
    let segmentStart = type.open + 1; depth = 0;
    for (let index = type.open + 1; index <= type.close; index += 1) {
      const value = tokens[index]?.value;
      if (value === "{") depth += 1;
      else if (value === "}") depth -= 1;
      if (value !== ";" || depth !== 0) continue;
      const segment = tokens.slice(segmentStart, index);
      segmentStart = index + 1;
      if (segment.some((token) => token.value === "(") || !segment.length) continue;
      const identifiers = segment.filter((token) => token.type === "identifier" && !MODIFIERS.has(token.value));
      if (identifiers.length < 2) continue;
      const field = identifiers.at(-1); const fieldType = identifiers.find((token) => token !== field);
      if (field && fieldType) type.fields.push({ name: field.value, type: fieldType.value, token: field });
    }
  }
  return { packageName, imports, importNames, annotations, types, tokens, parens };
}

function endpointFor(annotation) {
  const methods = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH" };
  const method = methods[annotation.name];
  if (!method) return null;
  const path = annotation.args.find((token) => token.type === "string")?.value || "/";
  return `${method} ${path.startsWith("/") ? path : `/${path}`}`;
}

function before(annotations, fact) {
  return annotations.filter((annotation) => annotation.end < fact.start && annotation.end >= fact.start - 24);
}

export function mapJavaStructureToGraph(input, syntax) {
  const scope = scopeFor(input); const nodes = new Map(); const edges = [];
  const addNode = (kind, qualified_name, token = null, provenance = "extracted", label = qualified_name) => {
    const identity = { ...scope, kind, qualified_name };
    const id = graphNodeId(identity);
    if (!nodes.has(id)) nodes.set(id, {
      ...identity, id, label, language: "java", provenance,
      start_line: token?.line ?? null, start_column: token?.column ?? null,
      end_line: token ? token.line : null, end_column: token ? token.column + token.value.length : null,
      extractor_version: EXTRACTOR_VERSION,
    });
    return nodes.get(id);
  };
  const addEdge = (source, target, relation, token, provenance = "extracted") => {
    const edge = {
      source_id: source.id, target_id: target.id, relation, repo_path: scope.repo_path,
      start_line: token?.line ?? null, start_column: token?.column ?? null,
      end_line: token ? token.line : null, end_column: token ? token.column + token.value.length : null,
      provenance, commit: scope.commit, extractor_version: EXTRACTOR_VERSION,
      source, target,
    };
    edge.id = graphEdgeId(edge); edges.push(edge);
  };
  const file = addNode("file", scope.repo_path, null, "extracted", scope.repo_path);
  if (syntax.packageName) addNode("package", syntax.packageName, null);
  const typeNodes = new Map();
  for (const type of syntax.types) {
    const node = addNode(type.kind, qualifiedType(type.name, syntax.packageName, syntax.imports), type.token);
    type.qualified_name = node.qualified_name; typeNodes.set(type.qualified_name, node);
    addEdge(file, node, "contains", type.token);
  }
  for (const imported of syntax.importNames) addEdge(file, addNode("external-type", imported.name, imported.token), "imports", imported.token);
  for (const type of syntax.types) {
    const source = typeNodes.get(type.qualified_name);
    for (const relation of type.relations) {
      const target = addNode("interface", qualifiedType(relation.target, syntax.packageName, syntax.imports), type.token, "resolved");
      addEdge(source, target, relation.relation, type.token);
    }
    for (const field of type.fields) addNode("field", `${type.qualified_name}.${field.name}`, field.token);
  }
  const methodGroups = new Map();
  for (const type of syntax.types) for (const method of type.methods) {
    const base = `${type.qualified_name}.${method.name}`;
    const records = methodGroups.get(base) || []; records.push({ type, method }); methodGroups.set(base, records);
  }
  const methodNodes = new Map();
  for (const [base, records] of methodGroups) records.forEach(({ method }, ordinal) => {
    const suffix = records.length > 1 ? `/${method.arity}${ordinal ? `-${ordinal + 1}` : ""}` : "";
    method.qualified_name = `${base}${suffix}`;
    methodNodes.set(method.qualified_name, addNode("method", method.qualified_name, method.token));
  });
  for (const annotation of syntax.annotations) {
    addNode("annotation", qualifiedType(annotation.name, syntax.packageName, syntax.imports), annotation.token);
  }
  for (const type of syntax.types) {
    const source = typeNodes.get(type.qualified_name);
    for (const annotation of syntax.annotations.filter((item) => item.start > type.open && item.end < type.close)) {
      if (annotation.name !== "Value") continue;
      const value = annotation.args.find((token) => token.type === "string")?.value || "";
      const key = value.match(/\$?\{?([A-Za-z0-9_.-]+)\}?/)?.[1];
      if (key) addEdge(source, addNode("configuration-key", key, annotation.token), "reads-config", annotation.token);
    }
    for (const method of type.methods) {
      const methodNode = methodNodes.get(method.qualified_name);
      for (const annotation of syntax.annotations.filter((item) => item.start > type.open && item.end < method.start && item.end >= method.start - 24)) {
        const endpoint = endpointFor(annotation);
        if (endpoint) addEdge(methodNode, addNode("endpoint", endpoint, annotation.token), "exposes", annotation.token);
      }
      const fieldTypes = new Map(type.fields.map((field) => [field.name, qualifiedType(field.type, syntax.packageName, syntax.imports)]));
      for (let index = method.end + 1; index < (method.bodyClose ?? method.end); index += 1) {
        const receiver = syntax.tokens[index]; const dot = syntax.tokens[index + 1]; const called = syntax.tokens[index + 2]; const open = syntax.tokens[index + 3];
        if (receiver?.type !== "identifier" || dot?.value !== "." || called?.type !== "identifier" || open?.value !== "(") continue;
        const receiverType = fieldTypes.get(receiver.value); if (!receiverType) continue;
        const close = syntax.parens.get(index + 3); if (close === undefined) continue;
        const count = arity(syntax.tokens, index + 4, close, syntax.parens);
        const candidates = methodGroups.get(`${receiverType}.${called.value}`) || [];
        const candidate = candidates.find(({ method: declaration }) => declaration.arity === count);
        const targetName = candidate?.method.qualified_name || `${receiverType}.${called.value}`;
        const target = methodNodes.get(targetName) || addNode("method", targetName, called, "resolved");
        addEdge(methodNode, target, "calls", called, "resolved");
      }
    }
  }
  const uniqueEdges = [...new Map(edges.map((edge) => [edge.id, edge])).values()];
  const orderedNodes = [...nodes.values()].sort((left, right) => left.qualified_name.localeCompare(right.qualified_name) || left.kind.localeCompare(right.kind));
  uniqueEdges.sort((left, right) => {
    const relation = left.relation.localeCompare(right.relation); if (relation) return relation;
    const source = nodes.get(left.source_id).qualified_name.localeCompare(nodes.get(right.source_id).qualified_name);
    if (source) return source;
    return nodes.get(left.target_id).qualified_name.localeCompare(nodes.get(right.target_id).qualified_name);
  });
  return { nodes: orderedNodes, edges: uniqueEdges };
}

export function extractJavaSpring(input) {
  const tokens = tokenizeJava(input.text);
  const syntax = parseJavaStructure(tokens);
  return mapJavaStructureToGraph(input, syntax);
}
