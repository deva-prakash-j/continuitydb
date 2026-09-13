import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { acquireVaultInitializationLock } from "./file-lock.js";
import { validateProjectId } from "./project-identity.js";

function configPath(home) {
  return join(resolve(home), "config.json");
}

function assertHome(home) {
  if (!existsSync(home)) return;
  const metadata = lstatSync(home);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`vault home must be a real directory, not a symlink: ${home}`);
  }
}

function normalizeProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("registered project must be an object");
  }
  const id = validateProjectId(project.id);
  if (typeof project.root !== "string" || !isAbsolute(project.root)) {
    throw new Error(`registered project root must be an absolute path: ${id}`);
  }
  if (project.source !== "git" && project.source !== "explicit") {
    throw new Error(`registered project source must be git or explicit: ${id}`);
  }
  return { id, root: resolve(project.root), source: project.source };
}

function readConfig(home) {
  assertHome(home);
  const path = configPath(home);
  if (!existsSync(path)) return { path, config: {}, projects: [] };
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`vault config must be a regular file, not a symlink: ${path}`);
  }
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("vault config must contain a JSON object");
  }
  if (config.projects !== undefined && !Array.isArray(config.projects)) {
    throw new Error("vault config projects must be an array");
  }
  const projects = (config.projects || []).map(normalizeProject);
  const projectIds = new Set();
  const projectRoots = new Set();
  for (const project of projects) {
    if (projectIds.has(project.id)) {
      throw new Error(`project ${project.id} is registered more than once`);
    }
    const key = rootKey(project.root);
    if (projectRoots.has(key)) {
      throw new Error(`project root ${project.root} is registered more than once`);
    }
    projectIds.add(project.id);
    projectRoots.add(key);
  }
  return {
    path,
    config,
    projects,
  };
}

function rootHash(root) {
  const normalized = process.platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256").update(normalized).digest("hex");
}

function rootKey(root) {
  const fixed = resolve(root);
  return process.platform === "win32" ? fixed.toLowerCase() : fixed;
}

function preferredProjectId(root) {
  const digest = rootHash(root);
  const cleaned = basename(root)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 200);
  return validateProjectId(cleaned || `project-${digest.slice(0, 12)}`);
}

export function projectIdForRegisteredRoot(root, projects) {
  const fixedRoot = resolve(root);
  const existing = projects.find((project) => rootKey(project.root) === rootKey(fixedRoot));
  if (existing) return existing.id;
  const preferred = preferredProjectId(fixedRoot);
  if (!projects.some((project) => project.id === preferred)) return preferred;
  const digest = rootHash(fixedRoot);
  for (const length of [12, 16, 24, 32, 64]) {
    const availableBase = preferred.slice(0, 199 - length);
    const candidate = validateProjectId(`${availableBase}-${digest.slice(0, length)}`);
    if (!projects.some((project) => project.id === candidate)) return candidate;
  }
  throw new Error(`cannot derive a unique project identifier for ${fixedRoot}`);
}

function writeConfig(path, config) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary);
    throw error;
  }
}

export function listRegisteredProjects(home) {
  const resolvedHome = resolve(home);
  const releaseLock = acquireVaultInitializationLock(resolvedHome);
  try {
    return readConfig(resolvedHome).projects;
  } finally {
    releaseLock();
  }
}

export function registerProject(home, identity, { apply = false } = {}) {
  const resolvedHome = resolve(home);
  const project = normalizeProject(identity);
  const releaseLock = acquireVaultInitializationLock(resolvedHome);
  try {
    const { path, config, projects } = readConfig(resolvedHome);
    const existing = projects.find((item) => item.id === project.id);
    if (existing && existing.root !== project.root) {
      throw new Error(`project ${project.id} is already registered at ${existing.root}`);
    }
    const changed = !existing;
    const updated = changed ? [...projects, project] : projects;
    if (apply && changed) {
      mkdirSync(resolvedHome, { recursive: true, mode: 0o700 });
      assertHome(resolvedHome);
      writeConfig(path, { ...config, projects: updated });
    }
    return { changed, applied: Boolean(apply), projects: updated };
  } finally {
    releaseLock();
  }
}

export function ensureRegisteredProject(home, root, { apply = false, source = "git" } = {}) {
  const resolvedHome = resolve(home);
  const fixedRoot = resolve(root);
  const releaseLock = acquireVaultInitializationLock(resolvedHome);
  try {
    const { path, config, projects } = readConfig(resolvedHome);
    const existing = projects.find((project) => rootKey(project.root) === rootKey(fixedRoot));
    if (existing) return { project: existing, changed: false, applied: Boolean(apply), projects };
    const project = normalizeProject({
      id: projectIdForRegisteredRoot(fixedRoot, projects),
      root: fixedRoot,
      source,
    });
    const updated = [...projects, project];
    if (apply) {
      mkdirSync(resolvedHome, { recursive: true, mode: 0o700 });
      assertHome(resolvedHome);
      writeConfig(path, { ...config, projects: updated });
    }
    return { project, changed: true, applied: Boolean(apply), projects: updated };
  } finally {
    releaseLock();
  }
}
