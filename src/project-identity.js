import { lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * Validate the project identifier grammar used by connector allowlists.
 *
 * Project identifiers deliberately do not accept whitespace or a leading
 * punctuation character. Returning the original value keeps this helper
 * side-effect free and makes it suitable for use by setup and registry code.
 */
export function validateProjectId(value) {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new Error("invalid project identifier");
  }
  return value;
}

function metadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function assertRealDirectory(path, label = "project directory") {
  const item = metadata(path);
  if (!item) return false;
  if (item.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!item.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  return true;
}

/**
 * Find a Git root without invoking Git. A repository marker may be either a
 * real .git directory or a regular-file gitdir pointer (worktrees/submodules).
 */
export function findGitRoot(start) {
  const initial = resolve(start);
  const initialMetadata = metadata(initial);
  if (initialMetadata?.isSymbolicLink()) {
    throw new Error(`project directory must not be a symbolic link: ${initial}`);
  }
  if (initialMetadata && !initialMetadata.isDirectory()) {
    throw new Error(`project directory must be a real directory: ${initial}`);
  }

  // A project directory may be created as part of a later apply operation.
  // Start at its nearest existing ancestor while still checking every
  // existing path for symlinks.
  let current = initial;
  while (!metadata(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }

  while (true) {
    assertRealDirectory(current);
    const markerPath = join(current, ".git");
    const marker = metadata(markerPath);
    if (marker) {
      if (marker.isSymbolicLink()) throw new Error(`.git marker must not be a symbolic link: ${markerPath}`);
      if (!marker.isDirectory() && !marker.isFile()) {
        throw new Error(`.git marker must be a real directory or regular file: ${markerPath}`);
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveProjectIdentity({ projectDir, explicitProject } = {}) {
  const start = resolve(projectDir || process.cwd());
  if (explicitProject !== undefined && explicitProject !== null && explicitProject !== "") {
    return {
      id: validateProjectId(explicitProject),
      root: start,
      source: "explicit",
      git_root: findGitRoot(start),
    };
  }
  const gitRoot = findGitRoot(start);
  if (!gitRoot) {
    throw new Error("cannot infer a project identity outside a Git repository; pass --project <id>");
  }
  return {
    id: validateProjectId(basename(gitRoot)),
    root: gitRoot,
    source: "git",
    git_root: gitRoot,
  };
}
