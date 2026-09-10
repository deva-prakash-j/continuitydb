import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

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

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
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

export function scanRepository(inputPath, {
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
  const fileOutput = since
    ? git(root, ["diff", "--name-only", "-z", `${since}..HEAD`])
    : execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tracked = fileOutput.split("\0").filter(Boolean).slice(0, maxFiles);
  const records = [];
  const skipped = { denied: 0, symlink: 0, too_large: 0, unsupported: 0, unreadable: 0 };

  for (const repoPath of tracked) {
    if (DENIED_BASENAMES.test(repoPath)) { skipped.denied += 1; continue; }
    const extension = extname(repoPath);
    const supported = CODE_EXTENSIONS.has(extension)
      || (includeDocs && DOC_EXTENSIONS.has(extension))
      || /(?:package\.json|pom\.xml|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/.test(repoPath);
    if (!supported) { skipped.unsupported += 1; continue; }
    try {
      const candidate = join(root, repoPath);
      if (lstatSync(candidate).isSymbolicLink()) { skipped.symlink += 1; continue; }
      const canonical = realpathSync(candidate);
      if (!isWithin(root, canonical)) { skipped.symlink += 1; continue; }
      if (statSync(canonical).size > maxFileBytes) { skipped.too_large += 1; continue; }
      const text = readFileSync(canonical, "utf8");
      if (text.includes("\u0000")) { skipped.unsupported += 1; continue; }
      const checksum = createHash("sha256").update(text).digest("hex");
      const symbols = CODE_EXTENSIONS.has(extension) ? extractSymbols(text) : [];
      const dependencies = extractManifestFacts(repoPath, text);
      if (symbols.length || dependencies.length || DOC_EXTENSIONS.has(extension)) {
        const summary = [
          symbols.length ? `Symbols: ${symbols.map((item) => `${item.name}:${item.line}`).join(", ")}` : null,
          dependencies.length ? `Dependencies: ${dependencies.join(", ")}` : null,
          DOC_EXTENSIONS.has(extension) ? text.slice(0, 24_000) : null,
        ].filter(Boolean).join("\n");
        records.push({
          project_id: inferredProject,
          namespace_id: `project/${inferredProject}`,
          type: symbols.length ? "code-index" : dependencies.length ? "dependency-manifest" : "documentation",
          title: `${repoPath} at ${commit.slice(0, 12)}`,
          body: summary,
          source_type: "git",
          source_uri: remote ? `${remote}#${commit}:${repoPath}` : `git://${inferredProject}/${repoPath}`,
          repo_path: relative(root, canonical),
          git_commit: commit,
          branch,
          tags: ["git-grounded", symbols.length ? "code" : dependencies.length ? "dependency" : "docs"],
          metadata: { checksum, symbols, dependencies },
          idempotency_key: `git:${inferredProject}:${commit}:${repoPath}:${checksum}`,
        });
      }
    } catch {
      skipped.unreadable += 1;
    }
  }
  return {
    repository: { project_id: inferredProject, root, remote, commit, branch },
    scanned_files: tracked.length,
    produced_records: records.length,
    truncated: tracked.length === maxFiles,
    skipped,
    records,
  };
}
