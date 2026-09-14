import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".kts",
  ".php", ".py", ".rb", ".rs", ".scala", ".swift", ".ts", ".tsx", ".vue",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const DENIED_BASENAMES = /(^|\/)(?:\.env(?:\.|$)|\.git\/|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx)$|secrets?(?:\.|\/)|credentials?(?:\.|\/))/i;
const SYMBOL_PATTERNS = [
  /\b(?:class|interface|enum|record|trait|struct|type)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:public|private|protected|static|async|final|synchronized|abstract|export\s+)?(?:[A-Za-z_$][\w$<>,.?\[\] ]+\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:\{|=>)/g,
];
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sanitizeRemote(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
  }
}

function lineNumber(text, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) if (text.charCodeAt(offset) === 10) line += 1;
  return line;
}

function extractSymbols(text, limit = 200) {
  const found = new Map();
  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) && found.size < limit) {
      if (!found.has(match[1])) found.set(match[1], lineNumber(text, match.index));
    }
  }
  return [...found].map(([name, line]) => ({ name, line }));
}

function extractManifestFacts(path, text) {
  const facts = [];
  try {
    if (path.endsWith("package.json")) {
      const value = JSON.parse(text);
      const dependencies = { ...value.dependencies, ...value.devDependencies, ...value.peerDependencies };
      for (const [name, version] of Object.entries(dependencies)) facts.push(`npm:${name}@${version}`);
    } else if (path.endsWith("pom.xml")) {
      for (const match of text.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g)) {
        facts.push(`maven:${match[1]}:${match[2]}`);
      }
    } else if (/requirements[^/]*\.txt$/.test(path)) {
      for (const line of text.split("\n")) {
        const dependency = line.trim().match(/^([A-Za-z0-9_.-]+)/)?.[1];
        if (dependency) facts.push(`pypi:${dependency}`);
      }
    } else if (path.endsWith("go.mod")) {
      for (const match of text.matchAll(/^\s*([\w./-]+)\s+v\d+/gm)) facts.push(`go:${match[1]}`);
    } else if (path.endsWith("Cargo.toml")) {
      const section = text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/)?.[1] || "";
      for (const match of section.matchAll(/^([\w-]+)\s*=/gm)) facts.push(`cargo:${match[1]}`);
    }
  } catch {
    return [];
  }
  return [...new Set(facts)].slice(0, 1000);
}

export function readCommittedSnapshot(inputPath, {
  projectId,
  since = null,
  maxFiles = 20_000,
  maxFileBytes = 1_000_000,
  includeDocs = true,
} = {}) {
  const root = realpathSync(resolve(inputPath));
  git(root, ["rev-parse", "--is-inside-work-tree"]);
  const repositoryRoot = realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
  if (root !== repositoryRoot) throw new Error("scan path must be the Git repository root");
  const commit = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["branch", "--show-current"]) || null;
  const remote = (() => {
    try { return sanitizeRemote(git(root, ["remote", "get-url", "origin"])); } catch { return null; }
  })();
  const inferredProject = projectId || root.split(sep).at(-1);
  const changed = since
    ? new Set(execFileSync("git", ["-C", root, "diff", "--name-only", "-z", `${since}..HEAD`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean))
    : null;
  const tree = execFileSync("git", ["-C", root, "ls-tree", "-r", "-z", commit], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(\w+)\s+([a-f0-9]+)\t([\s\S]+)$/);
    if (!match) throw new Error("Git returned an invalid tree entry");
    return { mode: match[1], objectType: match[2], objectId: match[3], repoPath: match[4] };
  }).filter((entry) => !changed || changed.has(entry.repoPath));
  const tracked = tree.slice(0, maxFiles);
  const files = [];
  const skipped = { denied: 0, symlink: 0, too_large: 0, unsupported: 0, unreadable: 0 };

  for (const entry of tracked) {
    const { repoPath } = entry;
    if (DENIED_BASENAMES.test(repoPath)) { skipped.denied += 1; continue; }
    if (entry.objectType !== "blob" || entry.mode === "120000") { skipped.symlink += 1; continue; }
    const extension = extname(repoPath);
    const supported = CODE_EXTENSIONS.has(extension)
      || (includeDocs && DOC_EXTENSIONS.has(extension))
      || /(?:package\.json|pom\.xml|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/.test(repoPath);
    if (!supported) { skipped.unsupported += 1; continue; }
    try {
      const objectSize = Number(git(root, ["cat-file", "-s", entry.objectId]));
      if (!Number.isSafeInteger(objectSize) || objectSize < 0) throw new Error("invalid Git blob size");
      if (objectSize > maxFileBytes) { skipped.too_large += 1; continue; }
      const contents = execFileSync("git", ["-C", root, "cat-file", "blob", entry.objectId], {
        encoding: "buffer",
        maxBuffer: Math.max(objectSize + 1, 64 * 1024),
      });
      if (contents.includes(0)) { skipped.unsupported += 1; continue; }
      try { UTF8_DECODER.decode(contents); }
      catch { skipped.unsupported += 1; continue; }
      const checksum = createHash("sha256").update(contents).digest("hex");
      files.push({ repo_path: repoPath, git_object_id: entry.objectId, checksum, bytes: contents });
    } catch {
      skipped.unreadable += 1;
    }
  }
  const snapshot = {
    repository: { project_id: inferredProject, root, remote, commit, branch },
    truncated: tree.length > tracked.length,
    skipped,
    files,
  };
  Object.defineProperty(snapshot, "scanned_files", { value: tracked.length, enumerable: false });
  return snapshot;
}

// The record-facing API intentionally derives text only while producing memory
// records; raw committed bytes remain confined to the snapshot and graph paths.
export function scanRepository(inputPath, options = {}) {
  const snapshot = readCommittedSnapshot(inputPath, options);
  const { repository, files } = snapshot;
  const records = [];
  for (const file of files) {
    const text = file.bytes.toString("utf8");
    const extension = extname(file.repo_path);
    const symbols = CODE_EXTENSIONS.has(extension) ? extractSymbols(text) : [];
    const dependencies = extractManifestFacts(file.repo_path, text);
    if (!symbols.length && !dependencies.length && !DOC_EXTENSIONS.has(extension)) continue;
    const summary = [
      symbols.length ? `Symbols: ${symbols.map((item) => `${item.name}:${item.line}`).join(", ")}` : null,
      dependencies.length ? `Dependencies: ${dependencies.join(", ")}` : null,
      DOC_EXTENSIONS.has(extension) ? text.slice(0, 24_000) : null,
    ].filter(Boolean).join("\n");
    records.push({
      project_id: repository.project_id,
      namespace_id: `project/${repository.project_id}`,
      type: symbols.length ? "code-index" : dependencies.length ? "dependency-manifest" : "documentation",
      title: `${file.repo_path} at ${repository.commit.slice(0, 12)}`,
      body: summary,
      source_type: "git",
      source_uri: repository.remote ? `${repository.remote}#${repository.commit}:${file.repo_path}` : `git://${repository.project_id}/${file.repo_path}`,
      repo_path: file.repo_path,
      git_commit: repository.commit,
      branch: repository.branch,
      tags: ["git-grounded", symbols.length ? "code" : dependencies.length ? "dependency" : "docs"],
      metadata: {
        checksum: file.checksum,
        symbols,
        dependencies,
        provenance_mode: "committed-blob",
        git_object: file.git_object_id,
      },
      idempotency_key: `git:${repository.project_id}:${repository.commit}:${file.repo_path}:${file.checksum}`,
    });
  }
  return {
    repository,
    scanned_files: snapshot.scanned_files,
    produced_records: records.length,
    truncated: snapshot.truncated,
    skipped: snapshot.skipped,
    records,
  };
}
