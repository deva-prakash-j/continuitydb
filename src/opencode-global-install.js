import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { renderGlobalOpenCodePlugin } from "./opencode-global-plugin-template.js";
import { managedOpenCodeProject, migrateManagedOpenCodeProjects } from "./agent-connectors.js";
import { loadCapturePolicy } from "./capture-policy.js";

const OWNERSHIP_PREFIX = "// continuitydb managed global opencode ownership: ";
const MAX_PLUGIN_BYTES = 4 * 1024 * 1024;
const DEFAULT_SCAN_BUDGET = 20_000;
const SKIPPED_DIRECTORIES = new Set([".git", ".opencode", "node_modules", "vendor", "dist", "build", "target", ".venv", ".cache"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultOpenCodeConfigDir() {
  return resolve(homedir(), ".config", "opencode");
}

export function canonicalOpenCodeConfigDir(path, platform = process.platform) {
  const absolute = resolve(String(path));
  if (platform === "darwin" && (absolute === "/var" || absolute.startsWith("/var/"))) {
    return `/private${absolute}`;
  }
  return absolute;
}

function directoryMetadata(path) {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`OpenCode configuration parent must be a real directory, not a symbolic link: ${path}`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function bindDirectoryChain(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const paths = [root];
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  return paths.map((directory) => {
    const metadata = directoryMetadata(directory);
    if (!metadata) throw new Error(`OpenCode plugin parent is missing: ${directory}`);
    return { path: directory, ...metadata };
  });
}

function verifyDirectoryChain(binding) {
  for (const expected of binding) {
    const current = directoryMetadata(expected.path);
    if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error(`OpenCode plugin parent or ancestor changed: ${expected.path}`);
    }
  }
}

function ensureDirectory(path, apply) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const before = directoryMetadata(current);
    if (!before && apply) {
      mkdirSync(current, { mode: 0o700 });
      directoryMetadata(current);
    }
  }
  return directoryMetadata(absolute);
}

function readPlugin(path) {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`global OpenCode plugin must be a regular file, not a symbolic link: ${path}`);
  }
  if (metadata.size > MAX_PLUGIN_BYTES) throw new Error("global OpenCode plugin is too large");
  return readFileSync(path, "utf8");
}

function encodeMetadata(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseManagedPlugin(content) {
  if (content === null) return null;
  const newline = content.indexOf("\n");
  const header = newline < 0 ? content : content.slice(0, newline);
  if (!header.startsWith(OWNERSHIP_PREFIX)) {
    throw new Error("unmanaged global OpenCode plugin already exists");
  }
  let metadata;
  try { metadata = JSON.parse(Buffer.from(header.slice(OWNERSHIP_PREFIX.length), "base64url").toString("utf8")); }
  catch { throw new Error("invalid global OpenCode plugin ownership metadata"); }
  const core = newline < 0 ? "" : content.slice(newline + 1);
  if (metadata?.version !== 1 || !/^[a-f0-9]{64}$/.test(metadata.pluginSha256)
    || metadata.pluginSha256 !== sha256(core)
    || !isAbsolute(metadata.executable) || !isAbsolute(metadata.home)
    || !Array.isArray(metadata.workspaceRoots) || !metadata.workspaceRoots.length
    || metadata.workspaceRoots.some((root) => !isAbsolute(root))) {
    throw new Error("global OpenCode plugin ownership fingerprint mismatch");
  }
  return { metadata, core };
}

function renderedPlugin(options) {
  const core = renderGlobalOpenCodePlugin(options);
  const metadata = {
    version: 1,
    pluginSha256: sha256(core),
    executable: resolve(options.executable),
    home: resolve(options.home),
    workspaceRoots: options.workspaceRoots.map((root) => resolve(root)),
  };
  return `${OWNERSHIP_PREFIX}${encodeMetadata(metadata)}\n${core}`;
}

function durableWrite(path, content) {
  const parent = dirname(path);
  const binding = directoryMetadata(parent);
  if (!binding) throw new Error(`OpenCode plugin parent is missing: ${parent}`);
  const temporary = join(parent, `.continuitydb.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = null;
    const current = directoryMetadata(parent);
    if (!current || current.dev !== binding.dev || current.ino !== binding.ino) {
      throw new Error("OpenCode plugin parent changed before atomic replacement");
    }
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    if (process.platform !== "win32") {
      const parentDescriptor = openSync(parent, "r");
      try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw error;
  }
}

function restoreGlobalPlugin(path, expected, before) {
  const current = readPlugin(path);
  if (current !== expected) throw new Error("global OpenCode plugin changed concurrently during rollback");
  if (before === null) {
    const tombstone = join(dirname(path), `.continuitydb.${process.pid}.${randomUUID()}.rollback`);
    renameSync(path, tombstone);
    rmSync(tombstone, { force: true });
  } else durableWrite(path, before);
}

function commitGlobalPlugin(path, before, content) {
  let written = false;
  try {
    if (before !== content) {
      durableWrite(path, content);
      written = true;
    }
    const verified = globalOpenCodeStatus({ configDir: dirname(dirname(path)) });
    if (!verified.verified) {
      throw new Error(`global OpenCode plugin verification failed: ${verified.error || "unknown error"}`);
    }
    return {
      verified,
      rollback: () => {
        if (written) restoreGlobalPlugin(path, content, before);
      },
    };
  } catch (error) {
    if (written) {
      try { restoreGlobalPlugin(path, content, before); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "global OpenCode plugin commit failed and rollback was incomplete");
      }
    }
    throw error;
  }
}

function discoverLegacyAdapters(workspaceRoots, budget = DEFAULT_SCAN_BUDGET) {
  if (!Number.isInteger(budget) || budget < 1 || budget > 100_000) {
    throw new Error("OpenCode migration directory budget must be between 1 and 100000");
  }
  const stack = [...workspaceRoots].reverse();
  const found = [];
  let visited = 0;
  while (stack.length) {
    const directory = stack.pop();
    visited += 1;
    if (visited > budget) throw new Error(`OpenCode migration exceeded directory budget ${budget}`);
    const managed = managedOpenCodeProject(directory);
    if (managed) {
      found.push(managed);
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      stack.push(join(directory, entry.name));
    }
  }
  return found.sort((left, right) => left.projectDir.localeCompare(right.projectDir));
}

function normalizedOptions({
  configDir = defaultOpenCodeConfigDir(), workspaceRoots, home, binary,
  tenantId = "local", ownerId = "local-user", sensitivities = ["public", "private"],
  capturePolicyFile = null,
} = {}) {
  const fixedConfigDir = canonicalOpenCodeConfigDir(configDir);
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length < 1 || workspaceRoots.length > 64) {
    throw new Error("one to sixty-four workspace roots are required");
  }
  const roots = [...new Set(workspaceRoots.map((root) => {
    const fixed = resolve(String(root));
    const metadata = lstatSync(fixed);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`workspace root must be a real directory, not a symbolic link: ${fixed}`);
    }
    return realpathSync.native(fixed);
  }))];
  if (!isAbsolute(String(home || "")) || !isAbsolute(String(binary || ""))) {
    throw new Error("global OpenCode install requires absolute home and binary paths");
  }
  if (capturePolicyFile !== null) {
    if (typeof capturePolicyFile !== "string" || !isAbsolute(capturePolicyFile) || capturePolicyFile.includes("\0")) {
      throw new Error("global OpenCode capture policy file must be an absolute path");
    }
    loadCapturePolicy(capturePolicyFile);
  }
  return {
    configDir: fixedConfigDir,
    pluginDir: join(fixedConfigDir, "plugins"),
    plugin: join(fixedConfigDir, "plugins", "continuitydb.js"),
    workspaceRoots: roots,
    home: resolve(home),
    executable: resolve(binary),
    tenantId,
    ownerId,
    sensitivities,
    capturePolicyFile,
  };
}

export function globalOpenCodeStatus({ configDir = defaultOpenCodeConfigDir() } = {}) {
  const plugin = join(canonicalOpenCodeConfigDir(configDir), "plugins", "continuitydb.js");
  const content = readPlugin(plugin);
  if (content === null) return { installed: false, verified: false, drifted: false, plugin };
  try {
    const { metadata } = parseManagedPlugin(content);
    return {
      installed: true, verified: true, drifted: false, plugin,
      executable: metadata.executable, home: metadata.home, workspace_roots: metadata.workspaceRoots,
    };
  } catch (error) {
    return { installed: true, verified: false, drifted: true, plugin, error: error.message };
  }
}

export function installGlobalOpenCode(rawOptions = {}) {
  const options = normalizedOptions(rawOptions);
  ensureDirectory(options.configDir, false);
  ensureDirectory(options.pluginDir, false);
  const before = readPlugin(options.plugin);
  const owned = parseManagedPlugin(before);
  const content = renderedPlugin(options);
  const changed = before !== content;
  const legacy = discoverLegacyAdapters(options.workspaceRoots, rawOptions.scanBudget || DEFAULT_SCAN_BUDGET);
  const migrationOptions = {
    home: options.home,
    apply: Boolean(rawOptions.apply),
    transport: "stdio",
    tenantId: options.tenantId,
    ownerId: options.ownerId,
    sensitivities: options.sensitivities,
  };
  if (legacy.length) migrateManagedOpenCodeProjects(legacy, { ...migrationOptions, apply: false });
  if (!rawOptions.apply) {
    return {
      action: "install", applied: false, changed, verified: !changed && Boolean(owned),
      plugin: options.plugin, workspace_roots: options.workspaceRoots,
      migrated_projects: legacy.map((project) => project.projectDir),
    };
  }
  ensureDirectory(options.configDir, true);
  ensureDirectory(options.pluginDir, true);
  const rechecked = readPlugin(options.plugin);
  if (rechecked !== before) throw new Error("global OpenCode plugin changed after preflight");
  if (legacy.length) {
    migrateManagedOpenCodeProjects(legacy, {
      ...migrationOptions,
      apply: true,
      _finalize: () => {
        if (readPlugin(options.plugin) !== before) throw new Error("global OpenCode plugin changed after preflight");
        return commitGlobalPlugin(options.plugin, before, content);
      },
    });
  } else commitGlobalPlugin(options.plugin, before, content);
  const status = globalOpenCodeStatus({ configDir: options.configDir });
  if (!status.verified) throw new Error(`global OpenCode plugin verification failed: ${status.error || "unknown error"}`);
  return {
    action: "install", applied: true, changed: changed || legacy.length > 0,
    migrated_projects: legacy.map((project) => project.projectDir), ...status,
  };
}

export function uninstallGlobalOpenCode({ configDir = defaultOpenCodeConfigDir(), apply = false } = {}) {
  const fixedConfigDir = canonicalOpenCodeConfigDir(configDir);
  const plugin = join(fixedConfigDir, "plugins", "continuitydb.js");
  if (!existsSync(plugin)) {
    return { action: "uninstall", applied: Boolean(apply), changed: false, verified: true, plugin };
  }
  const parentBinding = bindDirectoryChain(dirname(plugin));
  verifyDirectoryChain(parentBinding);
  const before = readPlugin(plugin);
  const owned = parseManagedPlugin(before);
  if (!owned) return { action: "uninstall", applied: Boolean(apply), changed: false, verified: true, plugin };
  if (!apply) return { action: "uninstall", applied: false, changed: true, verified: true, plugin };
  const rechecked = readPlugin(plugin);
  if (rechecked !== before) throw new Error("global OpenCode plugin changed after preflight");
  verifyDirectoryChain(parentBinding);
  const tombstone = join(dirname(plugin), `.continuitydb.${process.pid}.${randomUUID()}.removed`);
  renameSync(plugin, tombstone);
  rmSync(tombstone, { force: true });
  return { action: "uninstall", applied: true, changed: true, verified: !existsSync(plugin), plugin };
}
