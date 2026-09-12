import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isStandaloneBinary } from "./binary-runtime.js";
import { defaultDataHome } from "./paths.js";
import { acquireFileLock, acquireFileLocks } from "./file-lock.js";
import { resolveProjectIdentity, validateProjectId } from "./project-identity.js";

export const SUPPORTED_AGENTS = Object.freeze(["codex", "claude", "opencode", "cursor", "copilot"]);
const MAX_CONFIG_BYTES = 1024 * 1024;
const CODEX_START = "# >>> continuitydb managed configuration >>>";
const CODEX_END = "# <<< continuitydb managed configuration <<<";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contains(root, target) {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function ensureSafeParents(root, target, apply) {
  if (!contains(root, target)) throw new Error(`refusing to write outside project directory: ${target}`);
  const relativeParent = relative(root, dirname(target));
  let current = root;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("project directory must not be a symlink");
  const created = [];
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`configuration parent must be a real directory: ${current}`);
    } else if (apply) {
      mkdirSync(current, { mode: 0o700 });
      created.push(current);
    }
  }
  return created;
}

function readText(path) {
  if (!existsSync(path)) return "";
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`configuration must be a regular file, not a symlink: ${path}`);
  if (metadata.size > MAX_CONFIG_BYTES) throw new Error(`configuration exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`);
  return readFileSync(path, "utf8");
}

function parseJson(path) {
  const text = readText(path);
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`configuration root must be a JSON object: ${path}`);
  return value;
}

function isPlainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function managedJsonNamespace(value, key, path) {
  if (value[key] === undefined) value[key] = {};
  if (!isPlainObject(value[key])) {
    throw new Error(`configuration namespace ${key} must be a JSON object: ${path}`);
  }
  return value[key];
}

function validateToml(text, path) {
  if (!text.trim()) return;
  try { parseToml(text); }
  catch (error) { throw new Error(`invalid TOML configuration ${path}: ${error.message}`); }
}

function managedCodexBlock(text) {
  const start = text.indexOf(CODEX_START);
  const end = text.indexOf(CODEX_END);
  const duplicateStart = start !== -1 && text.indexOf(CODEX_START, start + CODEX_START.length) !== -1;
  const duplicateEnd = end !== -1 && text.indexOf(CODEX_END, end + CODEX_END.length) !== -1;
  if ((start === -1) !== (end === -1) || duplicateStart || duplicateEnd || (start !== -1 && end < start)) {
    throw new Error("invalid ContinuityDB managed block in Codex config");
  }
  return start === -1 ? null : { start, end };
}

function backupExisting(path, backupRoot, client) {
  if (!existsSync(path)) return null;
  const value = readText(path);
  const digest = sha256(value);
  const directory = join(backupRoot, "agent-config", client);
  const createdDirectories = [];
  for (const candidate of [dirname(backupRoot), backupRoot, join(backupRoot, "agent-config"), directory]) {
    if (existsSync(candidate)) {
      const metadata = lstatSync(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`backup parent must be a real directory: ${candidate}`);
      }
    } else {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      createdDirectories.push(candidate);
    }
  }
  const destination = join(directory, `${basename(path)}.${digest.slice(0, 16)}.bak`);
  let createdFile = false;
  try {
    copyFileSync(path, destination, constants.COPYFILE_EXCL);
    createdFile = true;
    chmodSync(destination, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      cleanupBackupArtifacts({ path: destination, createdFile, createdDirectories });
      throw error;
    }
  }
  return { path: destination, createdFile, createdDirectories };
}

function cleanupBackupArtifacts(artifacts) {
  if (!artifacts) return;
  if (artifacts.createdFile && existsSync(artifacts.path)) {
    const metadata = lstatSync(artifacts.path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`refusing to remove unexpected backup artifact: ${artifacts.path}`);
    }
    rmSync(artifacts.path);
  }
  for (const directory of [...artifacts.createdDirectories].reverse()) {
    if (existsSync(directory)) rmdirSync(directory);
  }
}

function sameSnapshot(left, right) {
  return left.existed === right.existed
    && left.content === right.content
    && left.mode === right.mode;
}

function currentSnapshot(path) {
  return snapshot(path);
}

function cleanupCreatedDirectories(plan, result) {
  for (const directory of [...(result.createdDirectories || [])].reverse()) {
    if (contains(plan.options.projectDir, directory) && existsSync(directory)) {
      try { rmdirSync(directory); }
      catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; }
    }
  }
}

function configurationLockPath(path) {
  return join(dirname(path), `.${basename(path)}.continuitydb.lock`);
}

function atomicWrite(path, content, { root, home, client, apply, expected, beforeReplace }) {
  const createdDirectories = ensureSafeParents(root, path, apply);
  if (!apply) {
    const beforeState = currentSnapshot(path);
    if (expected && !sameSnapshot(beforeState, expected)) throw new Error(`configuration changed after preflight: ${path}`);
    return beforeState.content === content
      ? { path, changed: false, applied: false, backup: null, createdDirectories }
      : { path, changed: true, applied: false, backup: null, createdDirectories };
  }

  const lockPath = configurationLockPath(path);
  const releaseLock = acquireFileLock(lockPath);
  try {
    const beforeState = currentSnapshot(path);
    if (expected && !sameSnapshot(beforeState, expected)) throw new Error(`configuration changed after preflight: ${path}`);
    const before = beforeState.content || "";
    if (before === content) return { path, changed: false, applied: true, backup: null, createdDirectories };
    const backupArtifacts = backupExisting(path, join(home, "backups"), client);
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      if (beforeReplace) {
        if (process.env.NODE_ENV !== "test") throw new Error("connector replace test hook is available only in tests");
        beforeReplace({ path, lockPath });
      }
      // Detect direct writers that do not participate in ContinuityDB's lock
      // protocol. Participating connector processes serialize on lockPath.
      if (!sameSnapshot(currentSnapshot(path), beforeState)) {
        const error = new Error(`configuration changed before atomic replacement: ${path}`);
        error.continuitydbNoWrite = true;
        throw error;
      }
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary);
      cleanupBackupArtifacts(backupArtifacts);
      throw error;
    }
    return {
      path,
      changed: true,
      applied: true,
      backup: backupArtifacts?.path || null,
      backupArtifacts,
      createdDirectories,
      written: currentSnapshot(path),
    };
  } finally {
    releaseLock();
  }
}

function snapshot(path) {
  if (!existsSync(path)) return { existed: false, content: null, mode: null };
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`configuration must be a regular file, not a symlink: ${path}`);
  }
  return { existed: true, content: readText(path), mode: metadata.mode & 0o777 };
}

function restoreSnapshot(plan, result) {
  const { path, original } = plan;
  if (result.changed === false) return;
  const releaseLock = acquireFileLock(configurationLockPath(path));
  try {
    const current = currentSnapshot(path);
    const expected = result.written || { existed: true, content: plan.content, mode: 0o600 };
    if (!sameSnapshot(current, expected)) {
      cleanupCreatedDirectories(plan, result);
      cleanupBackupArtifacts(result.backupArtifacts);
      throw new Error(`rollback conflict: configuration changed concurrently: ${path}`);
    }
    if (original.existed) {
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.rollback`);
      writeFileSync(temporary, original.content, { flag: "wx", mode: original.mode || 0o600 });
      renameSync(temporary, path);
      chmodSync(path, original.mode || 0o600);
    } else if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`refusing to roll back non-file configuration target: ${path}`);
      }
      rmSync(path);
    }
    cleanupCreatedDirectories(plan, result);
    cleanupBackupArtifacts(result.backupArtifacts);
  } finally {
    releaseLock();
  }
}

function publicResult(plan, result) {
  const { createdDirectories: _createdDirectories, backupArtifacts: _backupArtifacts, ...value } = result;
  return { client: plan.client, project_dir: plan.options.projectDir, ...value };
}

function envFor(client, options) {
  return {
    CONTINUITYDB_TENANT_ID: options.tenantId,
    CONTINUITYDB_PRINCIPAL_ID: `${client}-agent`,
    CONTINUITYDB_OWNER_ID: options.ownerId,
    CONTINUITYDB_AGENT_ID: client,
    CONTINUITYDB_ALLOWED_PROJECTS: options.projects.join(","),
    CONTINUITYDB_ALLOWED_SENSITIVITIES: options.sensitivities.join(","),
  };
}

function executable(options) {
  if (options.binary) return resolve(options.binary);
  return isStandaloneBinary() ? process.execPath : "continuitydb";
}

function validateRemoteUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("MCP URL must not contain credentials, query, or fragment");
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("remote MCP URL must use HTTPS unless it is loopback");
  if (!url.pathname.endsWith("/mcp")) throw new Error("remote MCP URL must end with /mcp");
  return url.href;
}

function connection(client, options) {
  if (options.transport === "http") {
    const url = validateRemoteUrl(options.url);
    if (client === "opencode") return {
      type: "remote", url, enabled: true, oauth: false, timeout: 30_000,
      headers: { Authorization: `Bearer {env:${options.tokenEnv}}` },
    };
    if (client === "claude" || client === "cursor") return {
      type: "http", url, headers: { Authorization: `Bearer \${${options.tokenEnv}}` },
    };
    if (client === "copilot") return {
      type: "http", url, headers: { Authorization: `Bearer \${env:${options.tokenEnv}}` },
    };
    return { url, bearer_token_env_var: options.tokenEnv };
  }
  const command = executable(options);
  const args = ["mcp", "--home", options.home];
  const env = envFor(client, options);
  if (client === "opencode") return { type: "local", command: [command, ...args], enabled: true, environment: env };
  if (client === "copilot") return { type: "stdio", command, args, env };
  return { command, args, env };
}

function codexBlock(options) {
  const value = connection("codex", options);
  const lines = [CODEX_START, "[mcp_servers.continuitydb]"];
  if (options.transport === "http") {
    lines.push(`url = ${JSON.stringify(value.url)}`);
    lines.push(`bearer_token_env_var = ${JSON.stringify(value.bearer_token_env_var)}`);
  } else {
    lines.push(`command = ${JSON.stringify(value.command)}`);
    lines.push(`args = ${JSON.stringify(value.args)}`);
  }
  lines.push("required = true");
  lines.push('enabled_tools = ["memory_search", "memory_context_pack", "memory_capture", "memory_feedback", "handoff_checkpoint", "handoff_latest"]');
  lines.push('default_tools_approval_mode = "writes"');
  lines.push("startup_timeout_sec = 10");
  lines.push("tool_timeout_sec = 30");
  if (options.transport === "stdio") {
    lines.push("", "[mcp_servers.continuitydb.env]");
    for (const [key, item] of Object.entries(value.env)) lines.push(`${key} = ${JSON.stringify(item)}`);
  }
  lines.push(CODEX_END);
  return `${lines.join("\n")}\n`;
}

function replaceManagedToml(text, block, path) {
  validateToml(text, path);
  const managed = managedCodexBlock(text);
  const unmanaged = managed === null ? text : `${text.slice(0, managed.start)}${text.slice(managed.end + CODEX_END.length)}`;
  if (/^\s*\[mcp_servers\.continuitydb(?:\]|\.)/m.test(unmanaged)) {
    throw new Error("an unmanaged Codex continuitydb server already exists; remove or rename it before connecting");
  }
  const output = `${unmanaged.trimEnd()}${unmanaged.trim() ? "\n\n" : ""}${block}`;
  validateToml(output, path);
  return output;
}

function jsonTarget(client, projectDir) {
  if (client === "claude") return join(projectDir, ".mcp.json");
  if (client === "opencode") return join(projectDir, "opencode.json");
  if (client === "cursor") return join(projectDir, ".cursor", "mcp.json");
  if (client === "copilot") return join(projectDir, ".vscode", "mcp.json");
  throw new Error(`unsupported JSON client: ${client}`);
}

function connectedJson(client, current, options) {
  const value = structuredClone(current);
  if (client === "opencode") {
    value.$schema ||= "https://opencode.ai/config.json";
    managedJsonNamespace(value, "mcp", jsonTarget(client, options.projectDir)).continuitydb = connection(client, options);
  } else if (client === "copilot") {
    managedJsonNamespace(value, "servers", jsonTarget(client, options.projectDir)).continuitydb = connection(client, options);
  } else {
    managedJsonNamespace(value, "mcpServers", jsonTarget(client, options.projectDir)).continuitydb = connection(client, options);
  }
  return value;
}

function disconnectedJson(client, current, path) {
  const value = structuredClone(current);
  const key = client === "opencode" ? "mcp" : client === "copilot" ? "servers" : "mcpServers";
  if (value[key] !== undefined) delete managedJsonNamespace(value, key, path).continuitydb;
  return value;
}

function connectorIdentity(projectDir, options) {
  return options.projectId === undefined
    ? resolveProjectIdentity({ projectDir })
    : resolveProjectIdentity({ projectDir, explicitProject: options.projectId });
}

function normalizeOptions(options = {}, { identity = null } = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const home = resolve(options.home || defaultDataHome());
  const projects = identity
    ? [identity.id]
    : [...new Set((options.projects?.length ? options.projects : [basename(projectDir)]).map(String))];
  projects.forEach(validateProjectId);
  const tokenEnv = options.tokenEnv || "CONTINUITYDB_MCP_TOKEN";
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)) throw new Error("invalid token environment variable name");
  return {
    ...options,
    projectDir,
    home,
    identity,
    projects,
    tenantId: options.tenantId || "local",
    ownerId: options.ownerId || "local-user",
    sensitivities: options.sensitivities?.length ? options.sensitivities : ["public", "private"],
    transport: options.transport || "stdio",
    tokenEnv,
    apply: Boolean(options.apply),
  };
}

function prepareAgentChange(client, rawOptions, action, identity = null) {
  if (!SUPPORTED_AGENTS.includes(client)) throw new Error(`unsupported agent: ${client}`);
  const options = normalizeOptions(rawOptions, { identity });
  let path;
  let content;
  if (client === "codex") {
    path = join(options.projectDir, ".codex", "config.toml");
    const current = readText(path);
    validateToml(current, path);
    if (action === "connect") content = replaceManagedToml(current, codexBlock(options), path);
    else {
      const managed = managedCodexBlock(current);
      content = managed === null ? current
        : `${current.slice(0, managed.start)}${current.slice(managed.end + CODEX_END.length)}`.trimStart();
      validateToml(content, path);
    }
  } else {
    path = jsonTarget(client, options.projectDir);
    if (action === "disconnect" && !existsSync(path)) {
      ensureSafeParents(options.projectDir, path, false);
      return { client, action, options, path, content: "", original: snapshot(path), noOp: true };
    }
    const current = parseJson(path);
    const value = action === "connect" ? connectedJson(client, current, options) : disconnectedJson(client, current, path);
    content = `${JSON.stringify(value, null, 2)}\n`;
  }
  ensureSafeParents(options.projectDir, path, false);
  return { client, action, options, path, content, original: snapshot(path) };
}

function applyAgentPlans(plans) {
  if (!plans.length) return [];
  const apply = plans[0].options.apply;
  if (!plans.every((plan) => plan.options.apply === apply)) throw new Error("agent batch must use one apply mode");
  if (!apply) {
    return plans.map((plan) => plan.noOp
      ? publicResult(plan, { path: plan.path, changed: false, applied: false, backup: null, createdDirectories: [] })
      : publicResult(plan, atomicWrite(plan.path, plan.content, {
        root: plan.options.projectDir, home: plan.options.home, client: plan.client, apply: false, expected: plan.original,
      })));
  }

  const releaseBatchLocks = acquireFileLocks(plans.map((plan) => configurationLockPath(plan.path)));
  const committed = [];
  try {
    for (const plan of plans) {
      if (plan.noOp) {
        committed.push({ plan, result: { path: plan.path, changed: false, applied: true, backup: null, createdDirectories: [] } });
        continue;
      }
      const createdDirectories = ensureSafeParents(plan.options.projectDir, plan.path, true);
      let result;
      try {
        result = atomicWrite(plan.path, plan.content, {
          root: plan.options.projectDir, home: plan.options.home, client: plan.client, apply: true, expected: plan.original,
          beforeReplace: plan.options._testBeforeReplace,
        });
        result.createdDirectories = createdDirectories;
      } catch (error) {
        try {
          const current = currentSnapshot(plan.path);
          if (error.continuitydbNoWrite || sameSnapshot(current, plan.original)) {
            cleanupCreatedDirectories(plan, { createdDirectories });
          } else {
            restoreSnapshot(plan, {
              changed: true,
              createdDirectories,
              written: { existed: true, content: plan.content, mode: 0o600 },
            });
          }
        }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `agent configuration write failed and rollback was incomplete for ${plan.client}`);
        }
        throw error;
      }
      committed.push({ plan, result });
      if (plan.options._testAfterCommit) {
        if (process.env.NODE_ENV !== "test") throw new Error("agent commit test hook is available only in tests");
        plan.options._testAfterCommit({ plan, result, committed: committed.length });
      }
    }
    return committed.map(({ plan, result }) => publicResult(plan, result));
  } catch (error) {
    const rollbackErrors = [];
    for (const item of committed.reverse()) {
      try { restoreSnapshot(item.plan, item.result); }
      catch (rollbackError) { rollbackErrors.push(`${item.plan.client}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error], `agent configuration batch failed and rollback was incomplete: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  } finally {
    releaseBatchLocks();
  }
}

function batch(clients, rawOptions, action) {
  const unique = [...new Set(clients)];
  if (!unique.length) return [];
  const projectDir = resolve(rawOptions.projectDir || process.cwd());
  const identity = action === "connect" ? connectorIdentity(projectDir, rawOptions) : null;
  // Phase 1 is deliberately side-effect free. Every parser, namespace, marker,
  // path and rendered output must validate before the first client file changes.
  const plans = unique.map((client) => prepareAgentChange(client, rawOptions, action, identity));
  return applyAgentPlans(plans);
}

export function connectAgents(clients, rawOptions = {}) {
  return batch(clients, rawOptions, "connect").map((result) => ({ transport: normalizeOptions(rawOptions).transport, ...result }));
}

export function disconnectAgents(clients, rawOptions = {}) {
  return batch(clients, rawOptions, "disconnect");
}

export function connectAgent(client, rawOptions = {}) {
  return connectAgents([client], rawOptions)[0];
}

export function disconnectAgent(client, rawOptions = {}) {
  return disconnectAgents([client], rawOptions)[0];
}

export function connectionStatus(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  return SUPPORTED_AGENTS.map((client) => {
    const path = client === "codex" ? join(options.projectDir, ".codex", "config.toml") : jsonTarget(client, options.projectDir);
    try {
      if (!existsSync(path)) return { client, connected: false, path };
      if (client === "codex") {
        const text = readText(path);
        validateToml(text, path);
        return { client, connected: managedCodexBlock(text) !== null, path };
      }
      const value = parseJson(path);
      const key = client === "opencode" ? "mcp" : client === "copilot" ? "servers" : "mcpServers";
      const connected = value[key] === undefined ? false : Boolean(managedJsonNamespace(value, key, path).continuitydb);
      return { client, connected, path };
    } catch (error) {
      return { client, connected: false, path, error: error.message };
    }
  });
}

function executableCandidates(name, environment = process.env) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return String(environment.PATH || "").split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean).flatMap((directory) => suffixes.map((suffix) => join(directory, `${name}${suffix}`)));
}

export function detectAgents(environment = process.env) {
  const commands = { codex: "codex", claude: "claude", opencode: "opencode", cursor: "cursor", copilot: "code" };
  return SUPPORTED_AGENTS.map((client) => {
    const path = executableCandidates(commands[client], environment).find((candidate) => {
      try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch { return false; }
    }) || null;
    return { client, installed: Boolean(path), executable: path };
  });
}

export function setupAgentSummary({ requested = "detected", detectedAgents, connections }) {
  const detected = detectedAgents.filter((item) => item.installed).map((item) => item.client);
  const selected = [...new Set(connections.map((item) => item.client))];
  const planned = [...new Set(connections.filter((item) => item.applied !== true).map((item) => item.client))];
  const connected = [...new Set(connections.filter((item) => item.applied === true).map((item) => item.client))];
  return {
    requested,
    detected,
    selected,
    planned,
    connected,
    supported_not_installed: SUPPORTED_AGENTS.filter((client) => !detected.includes(client)),
  };
}

export function defaultInstallPrefix() {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || homedir(), "ContinuityDB")
    : join(homedir(), ".local");
}
