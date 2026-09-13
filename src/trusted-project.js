import { lstatSync, realpathSync } from "node:fs";
import { basename, posix, resolve, win32 } from "node:path";
import { ensureRegisteredProject, projectIdForRegisteredRoot } from "./project-registry.js";
import { findGitRoot } from "./project-identity.js";

function canonicalDirectory(path, label) {
  const resolved = resolve(String(path || ""));
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link: ${resolved}`);
  }
  return realpathSync.native(resolved);
}

export function pathIsInsideWorkspace(workspaceRoot, candidate, platform = process.platform) {
  const api = platform === "win32" ? win32 : posix;
  const normalize = (value) => {
    const fixed = api.resolve(String(value));
    return platform === "win32" ? fixed.toLowerCase() : fixed;
  };
  const root = normalize(workspaceRoot);
  const item = normalize(candidate);
  const relative = api.relative(root, item);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

export function projectIdForCanonicalRoot(root, projects) {
  return projectIdForRegisteredRoot(root, projects);
}

export function ensureTrustedProject(home, {
  directory,
  worktree = null,
  workspaceRoots,
  apply = false,
} = {}) {
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length < 1 || workspaceRoots.length > 64) {
    throw new Error("one to sixty-four trusted workspace roots are required");
  }
  const roots = [...new Set(workspaceRoots.map((root) => canonicalDirectory(root, "workspace root")))];
  const start = canonicalDirectory(worktree || directory, "OpenCode project directory");
  const gitRoot = findGitRoot(start);
  if (!gitRoot) throw new Error("OpenCode project must be a Git repository");
  const canonicalGitRoot = realpathSync.native(gitRoot);
  if (!roots.some((root) => pathIsInsideWorkspace(root, canonicalGitRoot))) {
    throw new Error(`project ${canonicalGitRoot} is outside trusted workspace roots`);
  }
  const result = ensureRegisteredProject(home, canonicalGitRoot, { apply, source: "git" });
  if (result.project.id !== basename(canonicalGitRoot)
    && !result.project.id.startsWith(`${basename(canonicalGitRoot).slice(0, 187)}-`)) {
    throw new Error("registered project identity does not match its canonical Git root");
  }
  return result;
}
