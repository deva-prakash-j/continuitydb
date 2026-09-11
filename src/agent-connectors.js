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
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isStandaloneBinary } from "./binary-runtime.js";
import { defaultDataHome } from "./paths.js";

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
  for (const part of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`configuration parent must be a real directory: ${current}`);
    } else if (apply) mkdirSync(current, { mode: 0o700 });
  }
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
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${basename(path)}.${digest.slice(0, 16)}.bak`);
  if (!existsSync(destination)) {
    copyFileSync(path, destination);
    chmodSync(destination, 0o600);
  }
  return destination;
}

function atomicWrite(path, content, { root, home, client, apply }) {
  ensureSafeParents(root, path, apply);
  const before = readText(path);
  if (before === content) return { path, changed: false, applied: apply, backup: null };
  if (!apply) return { path, changed: true, applied: false, backup: null };
  const backup = backupExisting(path, join(home, "backups"), client);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return { path, changed: true, applied: true, backup };
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

function normalizeOptions(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const home = resolve(options.home || defaultDataHome());
  const projects = [...new Set((options.projects?.length ? options.projects : [basename(projectDir)]).map(String))];
  if (!projects.every((value) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value))) throw new Error("invalid project identifier");
  const tokenEnv = options.tokenEnv || "CONTINUITYDB_MCP_TOKEN";
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)) throw new Error("invalid token environment variable name");
  return {
    ...options,
    projectDir,
    home,
    projects,
    tenantId: options.tenantId || "local",
    ownerId: options.ownerId || "local-user",
    sensitivities: options.sensitivities?.length ? options.sensitivities : ["public", "private"],
    transport: options.transport || "stdio",
    tokenEnv,
    apply: Boolean(options.apply),
  };
}

export function connectAgent(client, rawOptions = {}) {
  if (!SUPPORTED_AGENTS.includes(client)) throw new Error(`unsupported agent: ${client}`);
  const options = normalizeOptions(rawOptions);
  let result;
  if (client === "codex") {
    const path = join(options.projectDir, ".codex", "config.toml");
    const text = replaceManagedToml(readText(path), codexBlock(options), path);
    result = atomicWrite(path, text, { root: options.projectDir, home: options.home, client, apply: options.apply });
  } else {
    const path = jsonTarget(client, options.projectDir);
    const current = parseJson(path);
    const value = connectedJson(client, current, options);
    result = atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, { root: options.projectDir, home: options.home, client, apply: options.apply });
  }
  return { client, transport: options.transport, project_dir: options.projectDir, ...result };
}

export function disconnectAgent(client, rawOptions = {}) {
  if (!SUPPORTED_AGENTS.includes(client)) throw new Error(`unsupported agent: ${client}`);
  const options = normalizeOptions(rawOptions);
  let result;
  if (client === "codex") {
    const path = join(options.projectDir, ".codex", "config.toml");
    const current = readText(path);
    validateToml(current, path);
    const managed = managedCodexBlock(current);
    const text = managed === null ? current
      : `${current.slice(0, managed.start)}${current.slice(managed.end + CODEX_END.length)}`.trimStart();
    validateToml(text, path);
    result = atomicWrite(path, text, { root: options.projectDir, home: options.home, client, apply: options.apply });
  } else {
    const path = jsonTarget(client, options.projectDir);
    if (!existsSync(path)) return { client, project_dir: options.projectDir, path, changed: false, applied: options.apply, backup: null };
    const current = parseJson(path);
    result = atomicWrite(path, `${JSON.stringify(disconnectedJson(client, current, path), null, 2)}\n`, {
      root: options.projectDir, home: options.home, client, apply: options.apply,
    });
  }
  return { client, project_dir: options.projectDir, ...result };
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

export function defaultInstallPrefix() {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || homedir(), "ContinuityDB")
    : join(homedir(), ".local");
}
