import { randomUUID } from "node:crypto";
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
import { isAbsolute, join, resolve } from "node:path";
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
  return {
    path,
    config,
    projects: (config.projects || []).map(normalizeProject),
  };
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
