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
import { validateTokenEnvironmentName } from "./http-client.js";
import { defaultDataHome } from "./paths.js";
import { renderOpenCodePlugin } from "./opencode-plugin-template.js";
import { acquireFileLock, acquireFileLocks } from "./file-lock.js";
import { resolveProjectIdentity, validateProjectId } from "./project-identity.js";
import { requiredIdentifier } from "./security.js";
import {
  mergeManagedText,
  POLICY_END,
  POLICY_START,
  policyAssetDescriptors,
  removeManagedText,
} from "./agent-policy.js";

export const SUPPORTED_AGENTS = Object.freeze(["codex", "claude", "opencode", "cursor", "copilot"]);
const MAX_CONFIG_BYTES = 1024 * 1024;
const CODEX_START = "# >>> continuitydb managed configuration >>>";
const CODEX_END = "# <<< continuitydb managed configuration <<<";
const OPENCODE_PLUGIN_REFERENCE = "./.opencode/plugins/continuitydb.js";
const OPENCODE_OWNERSHIP_PREFIX = "// continuitydb managed opencode ownership: ";
const MCP_ONLY_OWNERSHIP_ENV = "CONTINUITYDB_MCP_ONLY_OWNERSHIP";
const MCP_ONLY_OWNERSHIP_HEADER = "X-ContinuityDB-MCP-Only-Ownership";
const MCP_ONLY_OWNERSHIP_PLACEHOLDER = "__CONTINUITYDB_MCP_ONLY_OWNERSHIP__";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
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
  const relocated = !existsSync(artifacts.path)
    && artifacts.relocatedPath
    && existsSync(artifacts.relocatedPath);
  const artifactPath = existsSync(artifacts.path) ? artifacts.path : relocated ? artifacts.relocatedPath : null;
  if (artifacts.createdFile && artifactPath) {
    const metadata = lstatSync(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`refusing to remove unexpected backup artifact: ${artifactPath}`);
    }
    rmSync(artifactPath);
  }
  const createdDirectories = relocated
    ? artifacts.relocatedCreatedDirectories || artifacts.createdDirectories
    : artifacts.createdDirectories;
  for (const directory of [...createdDirectories].reverse()) {
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

function atomicWrite(path, content, { root, home, backupHome, client, apply, expected, beforeReplace }) {
  const createdDirectories = ensureSafeParents(root, path, apply);
  if (!apply) {
    const beforeState = currentSnapshot(path);
    if (expected && !sameSnapshot(beforeState, expected)) throw new Error(`configuration changed after preflight: ${path}`);
    return beforeState.content === content
      ? { path, changed: false, applied: false, verified: true, backup: null, createdDirectories }
      : { path, changed: true, applied: false, verified: false, backup: null, createdDirectories };
  }

  const lockPath = configurationLockPath(path);
  const releaseLock = acquireFileLock(lockPath);
  try {
    const beforeState = currentSnapshot(path);
    if (expected && !sameSnapshot(beforeState, expected)) throw new Error(`configuration changed after preflight: ${path}`);
    const before = beforeState.content || "";
    if (before === content) {
      return { path, changed: false, applied: true, verified: true, backup: null, createdDirectories };
    }
    const backupArtifacts = backupExisting(path, join(backupHome || home, "backups"), client);
    if (backupArtifacts && backupHome && resolve(backupHome) !== resolve(home)) {
      backupArtifacts.relocatedPath = join(home, relative(backupHome, backupArtifacts.path));
      backupArtifacts.relocatedCreatedDirectories = backupArtifacts.createdDirectories
        .map((directory) => join(home, relative(backupHome, directory)));
      backupArtifacts.publicPath = backupArtifacts.relocatedPath;
    }
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
      verified: false,
      backup: backupArtifacts?.path || null,
      backupArtifacts,
      createdDirectories,
      written: currentSnapshot(path),
    };
  } finally {
    releaseLock();
  }
}

function atomicRemove(path, { root, home, backupHome, client, apply, expected, beforeReplace }) {
  const createdDirectories = ensureSafeParents(root, path, false);
  if (!apply) {
    const beforeState = currentSnapshot(path);
    if (expected && !sameSnapshot(beforeState, expected)) throw new Error(`configuration changed after preflight: ${path}`);
    return {
      path,
      changed: beforeState.existed,
      applied: false,
      verified: !beforeState.existed,
      backup: null,
      createdDirectories,
    };
  }

  const lockPath = configurationLockPath(path);
  const releaseLock = acquireFileLock(lockPath);
  try {
    const beforeState = currentSnapshot(path);
    if (expected && !sameSnapshot(beforeState, expected)) throw new Error(`configuration changed after preflight: ${path}`);
    if (!beforeState.existed) {
      return { path, changed: false, applied: true, verified: false, backup: null, createdDirectories };
    }
    const backupArtifacts = backupExisting(path, join(backupHome || home, "backups"), client);
    if (backupArtifacts && backupHome && resolve(backupHome) !== resolve(home)) {
      backupArtifacts.relocatedPath = join(home, relative(backupHome, backupArtifacts.path));
      backupArtifacts.relocatedCreatedDirectories = backupArtifacts.createdDirectories
        .map((directory) => join(home, relative(backupHome, directory)));
      backupArtifacts.publicPath = backupArtifacts.relocatedPath;
    }
    try {
      if (beforeReplace) {
        if (process.env.NODE_ENV !== "test") throw new Error("connector replace test hook is available only in tests");
        beforeReplace({ path, lockPath });
      }
      if (!sameSnapshot(currentSnapshot(path), beforeState)) {
        const error = new Error(`configuration changed before atomic removal: ${path}`);
        error.continuitydbNoWrite = true;
        throw error;
      }
      rmSync(path);
    } catch (error) {
      cleanupBackupArtifacts(backupArtifacts);
      throw error;
    }
    return {
      path,
      changed: true,
      applied: true,
      verified: false,
      backup: backupArtifacts?.path || null,
      backupArtifacts,
      createdDirectories,
      written: { existed: false, content: null, mode: null },
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
      ensureSafeParents(plan.options.projectDir, path, true);
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
  if (result.backupArtifacts?.publicPath && value.backup) value.backup = result.backupArtifacts.publicPath;
  return {
    client: plan.client,
    project_dir: plan.options.projectDir,
    kind: plan.kind,
    owner: plan.owner,
    ...value,
  };
}

function verifyCommittedAgentPlans(committed) {
  for (const { plan, result } of committed) {
    const expected = result.written || plan.original;
    if (!sameSnapshot(currentSnapshot(plan.path), expected)) {
      throw new Error(`configuration changed after commit verification: ${plan.path}`);
    }
    result.verified = true;
  }
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

function codexOwnedEntry(options) {
  const value = connection("codex", options);
  return {
    ...(options.transport === "http"
      ? { url: value.url, bearer_token_env_var: value.bearer_token_env_var }
      : { command: value.command, args: value.args }),
    required: true,
    enabled_tools: ["memory_search", "memory_context_pack", "memory_capture", "memory_feedback", "handoff_checkpoint", "handoff_latest"],
    default_tools_approval_mode: "writes",
    startup_timeout_sec: 10,
    tool_timeout_sec: 30,
    ...(options.transport === "stdio" ? { env: value.env } : {}),
  };
}

function encodeCodexMetadata(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCodexMetadata(value) {
  let metadata;
  try { metadata = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid ContinuityDB managed Codex metadata"); }
  if (metadata?.version !== 1 || !["complete", "mcp-only"].includes(metadata.mode)
    || validateProjectId(metadata.projectId) !== metadata.projectId
    || typeof metadata.separator !== "boolean"
    || !/^[a-f0-9]{64}$/.test(metadata.entrySha256)) {
    throw new Error("invalid ContinuityDB managed Codex metadata");
  }
  return metadata;
}

function codexBlock(options, separator) {
  const value = connection("codex", options);
  const ownedEntry = codexOwnedEntry(options);
  const metadata = encodeCodexMetadata({
    version: 1,
    mode: options.mcpOnly ? "mcp-only" : "complete",
    projectId: options.identity.id,
    separator,
    entrySha256: entryFingerprint(ownedEntry),
  });
  const lines = [
    CODEX_START,
    `# continuitydb managed metadata: ${metadata}`,
  ];
  lines.push("[mcp_servers.continuitydb]");
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
  const output = managed === null
    ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${block}`
    : `${text.slice(0, managed.start)}${block.slice(0, -1)}${text.slice(managed.end + CODEX_END.length)}`;
  validateToml(output, path);
  return output;
}

function codexManagedMetadata(text, { allowLegacy = true } = {}) {
  const managed = managedCodexBlock(text);
  if (!managed) return null;
  const block = text.slice(managed.start, managed.end + CODEX_END.length);
  const matches = [...block.matchAll(/^# continuitydb managed metadata: ([A-Za-z0-9_-]+)$/gm)];
  if (matches.length === 0 && allowLegacy) return { managed, block, metadata: null, entry: null };
  if (matches.length !== 1) throw new Error("invalid ContinuityDB managed Codex metadata");
  const metadata = decodeCodexMetadata(matches[0][1]);
  const entry = parseToml(block).mcp_servers?.continuitydb;
  if (!entry || entryFingerprint(entry) !== metadata.entrySha256) {
    throw new Error("Codex MCP ownership fingerprint mismatch");
  }
  return { managed, block, metadata, entry };
}

function removeCodexManagedBlock(text, ownership) {
  const { managed, metadata } = ownership;
  let prefix = text.slice(0, managed.start);
  let suffix = text.slice(managed.end + CODEX_END.length);
  // The rendered block owns its one terminal LF. Any further LF/CRLF belongs
  // to post-connect user content and must remain byte-exact.
  if (suffix.startsWith("\n")) suffix = suffix.slice(1);
  if (metadata?.separator && prefix.endsWith("\n")) {
    const withoutSeparator = prefix.slice(0, -1);
    // A separator inserted for an original no-terminal-LF document can be
    // removed only at EOF or when the user-owned suffix already begins on a
    // new line. Otherwise retain it as the necessary TOML token boundary.
    if (!withoutSeparator || !suffix || suffix.startsWith("\n") || suffix.startsWith("\r\n")) {
      prefix = withoutSeparator;
    }
  }
  return `${prefix}${suffix}`;
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
  } else {
    managedJsonNamespace(value, "mcpServers", jsonTarget(client, options.projectDir)).continuitydb = connection(client, options);
  }
  return value;
}

function disconnectedJson(client, current, path) {
  const value = structuredClone(current);
  const key = client === "opencode" ? "mcp" : "mcpServers";
  if (value[key] !== undefined) {
    const namespace = managedJsonNamespace(value, key, path);
    delete namespace.continuitydb;
  }
  return value;
}

function lifecycleServiceUrl(mcpUrl) {
  const value = new URL(validateRemoteUrl(mcpUrl));
  value.pathname = value.pathname.slice(0, -3);
  return value.href;
}

function lifecycleArgs(client, options, action) {
  const args = ["hook", action, "--client", client, "--project", options.identity.id];
  if (options.transport === "http") {
    args.push("--http-url", lifecycleServiceUrl(options.url), "--http-token-env", options.tokenEnv);
  } else {
    args.push("--home", options.home);
    args.push(
      "--tenant-id", options.tenantId,
      "--owner-id", options.ownerId,
      "--agent-id", client,
      "--allowed-sensitivities", options.sensitivities.join(","),
    );
  }
  if (action === "checkpoint") args.push("--file", join(options.projectDir, ".continuitydb-handoff.json"));
  return args;
}

function shellWord(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function lifecycleEntries(client, options) {
  const command = executable(options);
  if (client === "claude") return {
    SessionStart: {
      matcher: "startup|resume|clear|compact",
      hooks: [{ type: "command", command, args: lifecycleArgs(client, options, "session-start"), timeout: 30 }],
    },
    Stop: {
      hooks: [{ type: "command", command, args: lifecycleArgs(client, options, "checkpoint"), timeout: 30 }],
    },
  };
  const render = (action) => [command, ...lifecycleArgs(client, options, action)].map(shellWord).join(" ");
  return {
    sessionStart: { command: render("session-start") },
    stop: { command: render("checkpoint") },
  };
}

function entryFingerprint(value) {
  return sha256(canonicalJson(value));
}

function encodedLifecycleTopology(topology) {
  return Buffer.from(JSON.stringify(topology), "utf8").toString("base64url");
}

function decodedLifecycleTopology(value, client) {
  let topology;
  try { topology = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error(`invalid ContinuityDB managed ${client} lifecycle topology`); }
  const validFile = (file) => file && ["missing", "empty", "existing"].includes(file.state)
    && (file.state === "missing" ? file.sha256 === null : /^[a-f0-9]{64}$/.test(file.sha256))
    && /^[a-f0-9]{64}$/.test(file.generated);
  const directoryKeys = Object.keys(topology?.directories || {}).sort().join(",");
  const expectedDirectoryKeys = client === "claude" ? "claude" : "cursor,rules";
  if (!topology || !validFile(topology.mcp) || !validFile(topology.hooks)
    || !topology.policy || !["missing", "empty", "existing"].includes(topology.policy.state)
    || typeof topology.policy.prefix !== "boolean"
    || (client === "claude" && topology.policy.prefix)
    || directoryKeys !== expectedDirectoryKeys
    || Object.values(topology.directories).some((item) => typeof item !== "boolean")) {
    throw new Error(`invalid ContinuityDB managed ${client} lifecycle topology`);
  }
  return topology;
}

function lifecyclePolicyContent(body, ownership, topology) {
  const metadata = `<!-- continuitydb managed lifecycle ownership: mcp_sha256=${ownership.mcp}; start_sha256=${ownership.start}; stop_sha256=${ownership.stop}; policy_sha256=${ownership.policy} -->`;
  const topologyMetadata = `<!-- continuitydb managed lifecycle topology: ${encodedLifecycleTopology(topology)} -->`;
  const firstLineEnd = body.indexOf("\n");
  return `${body.slice(0, firstLineEnd)}\n${metadata}\n${topologyMetadata}${body.slice(firstLineEnd)}`;
}

function lifecyclePolicyCore(client, content) {
  return client === "cursor" ? content.slice(content.indexOf(POLICY_START)) : content;
}

function lifecyclePolicyPrefix(client, content) {
  return client === "cursor" ? content.slice(0, content.indexOf(POLICY_START)) : "";
}

function lifecycleManagedBlock(current) {
  const start = current.indexOf(POLICY_START);
  if (start === -1) return null;
  const end = current.indexOf(POLICY_END, start);
  return current.slice(start, end + POLICY_END.length);
}

function lifecyclePolicyMetadata(current, client) {
  if (!current) return null;
  removeManagedText(current, { startMarker: POLICY_START, endMarker: POLICY_END });
  if (!current.includes(POLICY_START)) return null;
  const firstLine = current.slice(current.indexOf(POLICY_START), current.indexOf("\n", current.indexOf(POLICY_START)));
  if (firstLine !== `${POLICY_START} consumers: ${client}`) {
    throw new Error(`invalid ContinuityDB managed ${client} policy metadata`);
  }
  const ownership = [...current.matchAll(/<!-- continuitydb managed lifecycle ownership: mcp_sha256=([a-f0-9]{64}); start_sha256=([a-f0-9]{64}); stop_sha256=([a-f0-9]{64}); policy_sha256=([a-f0-9]{64}) -->/g)];
  if (ownership.length !== 1) throw new Error(`invalid ContinuityDB managed ${client} lifecycle ownership metadata`);
  const topologies = [...current.matchAll(/<!-- continuitydb managed lifecycle topology: ([A-Za-z0-9_-]+) -->/g)];
  if (topologies.length !== 1) throw new Error(`invalid ContinuityDB managed ${client} lifecycle topology metadata`);
  const projects = [...current.matchAll(/Project scope: `([^`]+)`\./g)];
  if (projects.length !== 1) throw new Error(`invalid ContinuityDB managed ${client} policy project scope`);
  return {
    projectId: validateProjectId(projects[0][1]),
    mcp: ownership[0][1],
    start: ownership[0][2],
    stop: ownership[0][3],
    policy: ownership[0][4],
    topology: decodedLifecycleTopology(topologies[0][1], client),
  };
}

function originalFileTopology(path, current) {
  return {
    state: existsSync(path) ? (current === "" ? "empty" : "existing") : "missing",
    sha256: existsSync(path) ? sha256(current) : null,
  };
}

function lifecycleBackupPath(options, client, path, digest) {
  return join(options.home, "backups", "agent-config", client, `${basename(path)}.${digest.slice(0, 16)}.bak`);
}

function restoredLifecycleContent(options, client, path, topology) {
  if (topology.state === "missing") return { content: "", deleteTarget: true };
  const backupPath = lifecycleBackupPath(options, client, path, topology.sha256);
  if (!contains(options.home, backupPath)) throw new Error(`invalid ${client} lifecycle backup path`);
  for (const directory of [
    options.home,
    join(options.home, "backups"),
    join(options.home, "backups", "agent-config"),
    join(options.home, "backups", "agent-config", client),
  ]) {
    if (!existsSync(directory)) throw new Error(`${client} lifecycle original backup is missing: ${path}`);
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${client} lifecycle backup parent must be a real directory: ${directory}`);
    }
  }
  const content = readText(backupPath);
  if (!existsSync(backupPath) || sha256(content) !== topology.sha256) {
    throw new Error(`${client} lifecycle original backup is missing or changed: ${path}`);
  }
  return { content, deleteTarget: false };
}

function lifecycleEventNames(client) {
  return client === "claude"
    ? { start: "SessionStart", stop: "Stop" }
    : { start: "sessionStart", stop: "stop" };
}

function findOwnedHookIndex(items, fingerprint) {
  return items.findIndex((item) => entryFingerprint(item) === fingerprint);
}

function looksLikeContinuityHook(value) {
  const text = JSON.stringify(value);
  return /continuitydb/i.test(text) && /(?:session-start|checkpoint|"hook")/.test(text);
}

function renderLifecycleHooks(client, current, path, options, metadata, action) {
  const value = structuredClone(current);
  if (client === "cursor") {
    if (value.version !== undefined && value.version !== 1) throw new Error(`Cursor hooks version must be 1: ${path}`);
    value.version = 1;
  }
  const hooks = managedJsonNamespace(value, "hooks", path);
  const names = lifecycleEventNames(client);
  const generated = lifecycleEntries(client, options);
  for (const [role, eventName] of Object.entries(names)) {
    if (hooks[eventName] !== undefined && !Array.isArray(hooks[eventName])) {
      throw new Error(`configuration hook ${eventName} must be a JSON array: ${path}`);
    }
    const items = [...(hooks[eventName] || [])];
    if (metadata) {
      const index = findOwnedHookIndex(items, metadata[role]);
      if (index !== -1) items.splice(index, 1);
      else if (items.some(looksLikeContinuityHook)) {
        throw new Error(`${client} lifecycle ownership fingerprint mismatch`);
      }
    } else if (items.some(looksLikeContinuityHook)) {
      throw new Error(`an unmanaged ${client} ContinuityDB lifecycle hook already exists`);
    }
    if (action === "connect") items.push(generated[eventName]);
    if (items.length) hooks[eventName] = items;
    else delete hooks[eventName];
  }
  if (Object.keys(hooks).length === 0) delete value.hooks;
  return { value, generated, names };
}

function skipJsonWhitespace(text, offset) {
  let position = offset;
  while (position < text.length && /\s/.test(text[position])) position += 1;
  return position;
}

function scanJsonString(text, offset) {
  let position = offset + 1;
  while (position < text.length) {
    if (text[position] === "\\") {
      position += 2;
    } else if (text[position] === '"') {
      return position + 1;
    } else {
      position += 1;
    }
  }
  throw new Error("unterminated JSON string");
}

function scanJsonValue(text, offset) {
  const start = skipJsonWhitespace(text, offset);
  if (text[start] === '"') return { type: "scalar", start, end: scanJsonString(text, start) };
  if (text[start] === "{") return scanJsonObject(text, start);
  if (text[start] === "[") {
    let position = start + 1;
    while (true) {
      position = skipJsonWhitespace(text, position);
      if (text[position] === "]") return { type: "array", start, end: position + 1 };
      const item = scanJsonValue(text, position);
      position = skipJsonWhitespace(text, item.end);
      if (text[position] === "]") return { type: "array", start, end: position + 1 };
      position += 1;
    }
  }
  let end = start;
  while (end < text.length && !/[\s,}\]]/.test(text[end])) end += 1;
  return { type: "scalar", start, end };
}

function scanJsonObject(text, start) {
  const properties = [];
  let position = start + 1;
  let precedingComma = null;
  while (true) {
    position = skipJsonWhitespace(text, position);
    if (text[position] === "}") return { type: "object", start, end: position + 1, properties };
    const keyStart = position;
    const keyEnd = scanJsonString(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    position = skipJsonWhitespace(text, keyEnd) + 1;
    const value = scanJsonValue(text, position);
    position = skipJsonWhitespace(text, value.end);
    const commaAfter = text[position] === "," ? position : null;
    properties.push({ key, keyStart, value, commaBefore: precedingComma, commaAfter });
    if (commaAfter === null) {
      position = skipJsonWhitespace(text, position);
    } else {
      precedingComma = commaAfter;
      position = commaAfter + 1;
    }
  }
}

function parseJsonLayout(text, path) {
  if (!text.trim()) return { value: {}, root: null };
  const value = JSON.parse(text);
  if (!isPlainObject(value)) throw new Error(`configuration root must be a JSON object: ${path}`);
  const root = scanJsonValue(text, 0);
  if (root.type !== "object") throw new Error(`configuration root must be a JSON object: ${path}`);
  return { value, root };
}

function propertyNamed(object, key) {
  const matches = object?.properties.filter((property) => property.key === key) || [];
  if (matches.length > 1) throw new Error(`duplicate JSON property is not supported: ${key}`);
  return matches[0] || null;
}

function insertJsonProperty(text, object, key, value) {
  const insertion = object.end - 1;
  const prefix = object.properties.length ? "," : "";
  return `${text.slice(0, insertion)}${prefix}${JSON.stringify(key)}:${JSON.stringify(value)}${text.slice(insertion)}`;
}

function removeJsonProperty(text, object, property) {
  let start = property.keyStart;
  let end = property.value.end;
  if (property.commaAfter !== null) {
    end = property.commaAfter + 1;
  } else if (property.commaBefore !== null) {
    start = property.commaBefore;
  }
  return `${text.slice(0, start)}${text.slice(end)}`;
}

function replaceJsonValue(text, property, value) {
  return `${text.slice(0, property.value.start)}${JSON.stringify(value)}${text.slice(property.value.end)}`;
}

function copilotEntryFingerprint(text, path) {
  const layout = parseJsonLayout(text, path);
  const servers = propertyNamed(layout.root, "servers");
  if (servers && servers.value.type !== "object") {
    throw new Error(`configuration namespace servers must be a JSON object: ${path}`);
  }
  const continuitydb = propertyNamed(servers?.value, "continuitydb");
  return continuitydb ? sha256(canonicalJson(layout.value.servers.continuitydb)) : null;
}

function connectCopilotJson(current, path, server, owned) {
  const layout = parseJsonLayout(current, path);
  if (layout.root === null) {
    return {
      content: `${current}${JSON.stringify({ servers: { continuitydb: server } })}`,
      ownership: {
        document: existsSync(path) ? "empty" : "missing",
        namespace: "created",
      },
    };
  }
  const servers = propertyNamed(layout.root, "servers");
  if (servers && servers.value.type !== "object") {
    throw new Error(`configuration namespace servers must be a JSON object: ${path}`);
  }
  const continuitydb = propertyNamed(servers?.value, "continuitydb");
  if (continuitydb && !owned) {
    throw new Error("an unmanaged Copilot continuitydb server already exists; remove or rename it before connecting");
  }
  if (continuitydb) {
    return { content: replaceJsonValue(current, continuitydb, server), ownership: owned };
  }
  if (servers) {
    return {
      content: insertJsonProperty(current, servers.value, "continuitydb", server),
      ownership: owned || { document: "existing", namespace: "existing" },
    };
  }
  return {
    content: insertJsonProperty(current, layout.root, "servers", { continuitydb: server }),
    ownership: owned || { document: "existing", namespace: "created" },
  };
}

function disconnectCopilotJson(current, path, ownership) {
  const layout = parseJsonLayout(current, path);
  if (layout.root === null) return { content: current, deleteTarget: false };
  const servers = propertyNamed(layout.root, "servers");
  if (servers && servers.value.type !== "object") {
    throw new Error(`configuration namespace servers must be a JSON object: ${path}`);
  }
  const continuitydb = propertyNamed(servers?.value, "continuitydb");
  if (!continuitydb) return { content: current, deleteTarget: false };
  if (!ownership) {
    throw new Error("an unmanaged Copilot continuitydb server already exists; refusing to disconnect it");
  }

  const onlyManagedServer = servers.value.properties.length === 1;
  const onlyManagedRoot = layout.root.properties.length === 1;
  if (ownership.namespace === "created" && onlyManagedServer) {
    if (ownership.document === "missing" && onlyManagedRoot) {
      return { content: "", deleteTarget: true };
    }
    if (ownership.document === "empty" && onlyManagedRoot) {
      return {
        content: `${current.slice(0, layout.root.start)}${current.slice(layout.root.end)}`,
        deleteTarget: false,
      };
    }
    return { content: removeJsonProperty(current, layout.root, servers), deleteTarget: false };
  }
  return { content: removeJsonProperty(current, servers.value, continuitydb), deleteTarget: false };
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
  validateTokenEnvironmentName(tokenEnv);
  const tenantId = requiredIdentifier(options.tenantId || "local", "tenant_id");
  const ownerId = requiredIdentifier(options.ownerId || "local-user", "owner_id");
  const sensitivities = options.sensitivities?.length ? [...new Set(options.sensitivities.map(String))] : ["public", "private"];
  if (sensitivities.some((value) => !["public", "private", "sensitive", "restricted"].includes(value))) {
    throw new Error("invalid allowed sensitivity");
  }
  return {
    ...options,
    projectDir,
    home,
    identity,
    projects,
    tenantId,
    ownerId,
    sensitivities,
    transport: options.transport || "stdio",
    tokenEnv,
    apply: Boolean(options.apply),
    mcpOnly: Boolean(options.mcpOnly),
  };
}

function encodeMcpOnlyOwnership(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeMcpOnlyOwnership(value) {
  let metadata;
  try { metadata = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid ContinuityDB MCP-only ownership metadata"); }
  if (metadata?.version !== 1 || metadata.mode !== "mcp-only"
    || validateProjectId(metadata.projectId) !== metadata.projectId
    || !metadata.original || !["missing", "empty", "existing"].includes(metadata.original.state)
    || (metadata.original.state === "missing"
      ? metadata.original.sha256 !== null
      : !/^[a-f0-9]{64}$/.test(metadata.original.sha256))
    || !/^[a-f0-9]{64}$/.test(metadata.entrySha256)
    || !/^[a-f0-9]{64}$/.test(metadata.generatedSha256)) {
    throw new Error("invalid ContinuityDB MCP-only ownership metadata");
  }
  return metadata;
}

function mcpOnlyOwnershipValue(server) {
  return server?.env?.[MCP_ONLY_OWNERSHIP_ENV]
    || server?.environment?.[MCP_ONLY_OWNERSHIP_ENV]
    || server?.headers?.[MCP_ONLY_OWNERSHIP_HEADER]
    || null;
}

function withoutMcpOnlyOwnership(server) {
  const value = structuredClone(server);
  for (const [container, key] of [
    [value.env, MCP_ONLY_OWNERSHIP_ENV],
    [value.environment, MCP_ONLY_OWNERSHIP_ENV],
    [value.headers, MCP_ONLY_OWNERSHIP_HEADER],
  ]) {
    if (!container) continue;
    delete container[key];
    if (Object.keys(container).length === 0) {
      if (container === value.env) delete value.env;
      else if (container === value.environment) delete value.environment;
      else delete value.headers;
    }
  }
  return value;
}

function attachMcpOnlyOwnership(server, metadata) {
  const value = structuredClone(server);
  const encoded = typeof metadata === "string" ? metadata : encodeMcpOnlyOwnership(metadata);
  if (value.env) value.env[MCP_ONLY_OWNERSHIP_ENV] = encoded;
  else if (value.environment) value.environment[MCP_ONLY_OWNERSHIP_ENV] = encoded;
  else {
    value.headers ||= {};
    value.headers[MCP_ONLY_OWNERSHIP_HEADER] = encoded;
  }
  return value;
}

function verifiedMcpOnlyMetadata(server, currentText) {
  const encoded = mcpOnlyOwnershipValue(server);
  if (!encoded) return null;
  const metadata = decodeMcpOnlyOwnership(encoded);
  if (entryFingerprint(withoutMcpOnlyOwnership(server)) !== metadata.entrySha256) {
    throw new Error("ContinuityDB MCP-only entry ownership fingerprint mismatch");
  }
  const needle = JSON.stringify(encoded);
  const first = currentText.indexOf(needle);
  if (first === -1 || currentText.indexOf(needle, first + needle.length) !== -1) {
    throw new Error("ContinuityDB MCP-only document ownership metadata is missing or duplicated");
  }
  const normalized = `${currentText.slice(0, first)}${JSON.stringify(MCP_ONLY_OWNERSHIP_PLACEHOLDER)}${currentText.slice(first + needle.length)}`;
  if (sha256(normalized) !== metadata.generatedSha256) {
    throw new Error("ContinuityDB MCP-only document ownership fingerprint mismatch");
  }
  return metadata;
}

function prepareMcpOnlyChange(client, rawOptions, action, identity) {
  if (client === "codex") {
    const projectDir = resolve(rawOptions.projectDir || process.cwd());
    const path = join(projectDir, ".codex", "config.toml");
    if (existsSync(path)) {
      const current = readText(path);
      const ownership = codexManagedMetadata(current);
      if (ownership?.metadata?.mode === "complete" || (ownership && !ownership.metadata)) {
        const detail = action === "disconnect"
          ? "refusing to disconnect a complete adapter with --mcp-only"
          : "disconnect the complete adapter before switching to MCP-only mode";
        throw new Error(`Codex adapter mode mismatch: ${detail}`);
      }
    }
    return {
      ...prepareMcpAgentChange(client, { ...rawOptions, mcpOnly: true }, action, identity),
      owner: "continuitydb-mcp-only",
    };
  }
  const baseOptions = normalizeOptions(rawOptions, { identity });
  const path = jsonTarget(client, baseOptions.projectDir);
  const currentText = readText(path);
  const current = parseJson(path);
  const key = client === "opencode" ? "mcp" : client === "copilot" ? "servers" : "mcpServers";
  const namespace = current[key] === undefined ? null : managedJsonNamespace(current, key, path);
  const existing = namespace?.continuitydb;
  const metadata = existing ? verifiedMcpOnlyMetadata(existing, currentText) : null;
  if (existing && !metadata) {
    throw new Error(`an unmanaged ${client} continuitydb server already exists; refusing to ${action}`);
  }
  if (metadata && action === "connect" && metadata.projectId !== identity.id) {
    throw new Error(`ContinuityDB managed ${client} MCP-only server belongs to project ${metadata.projectId}, not ${identity.id}`);
  }

  let content = currentText;
  let deleteTarget = false;
  let noOp = false;
  if (action === "connect") {
    const topology = metadata?.original || originalFileTopology(path, currentText);
    const restored = metadata
      ? restoredLifecycleContent(baseOptions, client, path, topology)
      : { content: currentText, deleteTarget: false };
    const original = restored.content.trim() ? JSON.parse(restored.content) : {};
    if (!isPlainObject(original)) throw new Error(`configuration root must be a JSON object: ${path}`);
    const value = structuredClone(original);
    const target = managedJsonNamespace(value, key, path);
    if (Object.prototype.hasOwnProperty.call(target, "continuitydb")) {
      throw new Error(`an unmanaged ${client} continuitydb server already exists; refusing to connect`);
    }
    if (client === "opencode") value.$schema ||= "https://opencode.ai/config.json";
    const server = connection(client, baseOptions);
    target.continuitydb = attachMcpOnlyOwnership(server, MCP_ONLY_OWNERSHIP_PLACEHOLDER);
    const placeholderContent = `${JSON.stringify(value, null, 2)}\n`;
    target.continuitydb = attachMcpOnlyOwnership(server, {
      version: 1,
      mode: "mcp-only",
      projectId: baseOptions.identity.id,
      original: topology,
      entrySha256: entryFingerprint(server),
      generatedSha256: sha256(placeholderContent),
    });
    content = `${JSON.stringify(value, null, 2)}\n`;
  } else if (metadata) {
    const restored = restoredLifecycleContent(baseOptions, client, path, metadata.original);
    content = restored.content;
    deleteTarget = restored.deleteTarget;
  } else {
    noOp = true;
  }
  ensureSafeParents(baseOptions.projectDir, path, false);
  return {
    client, action, options: baseOptions, path, content, original: snapshot(path),
    kind: "mcp", owner: "continuitydb-mcp-only", assetClients: [client], deleteTarget, noOp,
  };
}

function prepareMcpAgentChange(client, rawOptions, action, identity = null) {
  if (!SUPPORTED_AGENTS.includes(client)) throw new Error(`unsupported agent: ${client}`);
  const options = normalizeOptions(rawOptions, { identity });
  let path;
  let content;
  if (client === "codex") {
    path = join(options.projectDir, ".codex", "config.toml");
    const current = readText(path);
    validateToml(current, path);
    const ownership = codexManagedMetadata(current);
    const managed = ownership?.managed || null;
    if (action === "connect" && ownership?.metadata?.mode !== undefined
      && ownership.metadata.mode !== (options.mcpOnly ? "mcp-only" : "complete")) {
      throw new Error(`Codex ContinuityDB adapter mode is ${ownership.metadata.mode}; disconnect it before switching modes`);
    }
    const managedProject = ownership?.metadata?.projectId
      || ownership?.entry?.env?.CONTINUITYDB_ALLOWED_PROJECTS;
    if (action === "connect" && managedProject && managedProject !== identity.id) {
      throw new Error(`ContinuityDB managed Codex server belongs to project ${managedProject}, not ${identity.id}`);
    }
    if (action === "connect") {
      const separator = ownership?.metadata?.separator ?? (!managed && Boolean(current && !current.endsWith("\n")));
      content = replaceManagedToml(current, codexBlock(options, separator), path);
    } else {
      content = ownership === null ? current : removeCodexManagedBlock(current, ownership);
      validateToml(content, path);
    }
  } else {
    path = jsonTarget(client, options.projectDir);
    if (action === "disconnect" && !existsSync(path)) {
      ensureSafeParents(options.projectDir, path, false);
      return {
        client, action, options, path, content: "", original: snapshot(path), noOp: true,
        kind: "mcp", owner: "continuitydb-mcp", assetClients: [client],
      };
    }
    const current = parseJson(path);
    const value = action === "connect" ? connectedJson(client, current, options) : disconnectedJson(client, current, path);
    content = `${JSON.stringify(value, null, 2)}\n`;
  }
  ensureSafeParents(options.projectDir, path, false);
  return {
    client, action, options, path, content, original: snapshot(path),
    kind: "mcp", owner: "continuitydb-mcp", assetClients: [client],
  };
}

function opencodePluginMetadata(content) {
  if (!content) return null;
  const firstLineEnd = content.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
  if (!firstLine.startsWith(OPENCODE_OWNERSHIP_PREFIX)) {
    throw new Error("unmanaged OpenCode plugin already exists; remove or rename it before connecting");
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(firstLine.slice(OPENCODE_OWNERSHIP_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid ContinuityDB managed OpenCode plugin ownership metadata");
  }
  const file = value?.config;
  if (value?.version !== 1 || validateProjectId(value.projectId) !== value.projectId
    || !/^[a-f0-9]{64}$/.test(value.pluginSha256)
    || !file || !["missing", "empty", "existing"].includes(file.state)
    || (file.state === "missing" ? file.sha256 !== null : !/^[a-f0-9]{64}$/.test(file.sha256))
    || !/^[a-f0-9]{64}$/.test(file.generated)
    || !value.directories || typeof value.directories.opencode !== "boolean"
    || typeof value.directories.plugins !== "boolean") {
    throw new Error("invalid ContinuityDB managed OpenCode plugin ownership metadata");
  }
  const core = firstLineEnd === -1 ? "" : content.slice(firstLineEnd + 1);
  if (sha256(core) !== value.pluginSha256) throw new Error("OpenCode plugin ownership fingerprint mismatch");
  return { ...value, core };
}

function opencodeConfigValue(path) {
  const value = parseJson(path);
  if (value.plugin !== undefined && !Array.isArray(value.plugin)) {
    throw new Error(`OpenCode plugin configuration must be an array: ${path}`);
  }
  if (value.plugin?.some((item) => typeof item !== "string")) {
    throw new Error(`OpenCode plugin configuration entries must be strings: ${path}`);
  }
  return value;
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function assertUnmanagedOpenCodeConfig(value, path, action) {
  const namespace = value.mcp === undefined ? null : managedJsonNamespace(value, "mcp", path);
  if (hasOwn(namespace, "continuitydb")) {
    throw new Error(`an unmanaged OpenCode continuitydb server already exists; refusing to ${action}`);
  }
  if (value.plugin?.includes(OPENCODE_PLUGIN_REFERENCE)) {
    throw new Error(`an unmanaged OpenCode plugin reference already exists; refusing to ${action}`);
  }
}

function connectedOpenCodeConfig(current, options) {
  const value = structuredClone(current);
  value.$schema ||= "https://opencode.ai/config.json";
  managedJsonNamespace(value, "mcp", jsonTarget("opencode", options.projectDir)).continuitydb = connection("opencode", options);
  const plugins = value.plugin ? [...value.plugin] : [];
  if (!plugins.includes(OPENCODE_PLUGIN_REFERENCE)) plugins.push(OPENCODE_PLUGIN_REFERENCE);
  value.plugin = plugins;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function encodedOpenCodeMetadata(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function prepareOpenCodeChanges(rawOptions, action, identity) {
  const client = "opencode";
  const options = normalizeOptions(rawOptions, { identity });
  const configPath = jsonTarget(client, options.projectDir);
  const pluginPath = join(options.projectDir, ".opencode", "plugins", "continuitydb.js");
  const pluginCurrent = readText(pluginPath);
  const metadata = opencodePluginMetadata(pluginCurrent);
  if (existsSync(pluginPath) && !metadata) {
    throw new Error("unmanaged OpenCode plugin already exists; remove or rename it before connecting");
  }
  const configCurrent = readText(configPath);
  const parsedCurrent = opencodeConfigValue(configPath);

  if (!metadata) assertUnmanagedOpenCodeConfig(parsedCurrent, configPath, action);
  if (metadata) {
    const requestedProject = action === "connect" ? identity.id : rawOptions.projectId;
    if (requestedProject && metadata.projectId !== requestedProject) {
      throw new Error(`ContinuityDB managed OpenCode plugin belongs to project ${metadata.projectId}, not ${requestedProject}`);
    }
    if (!existsSync(configPath) || sha256(configCurrent) !== metadata.config.generated) {
      throw new Error("OpenCode configuration ownership fingerprint mismatch");
    }
  }

  let configContent;
  let pluginContent = "";
  let deleteConfig = false;
  let deletePlugin = false;
  let cleanupDirectories = [];
  if (action === "connect") {
    const original = metadata
      ? restoredLifecycleContent(options, client, configPath, metadata.config)
      : { content: configCurrent, deleteTarget: false };
    const originalValue = original.content.trim() ? JSON.parse(original.content) : {};
    if (!isPlainObject(originalValue)) throw new Error(`configuration root must be a JSON object: ${configPath}`);
    if (originalValue.plugin !== undefined && !Array.isArray(originalValue.plugin)) {
      throw new Error(`OpenCode plugin configuration must be an array: ${configPath}`);
    }
    if (!metadata) assertUnmanagedOpenCodeConfig(originalValue, configPath, action);
    configContent = connectedOpenCodeConfig(originalValue, options);
    const core = renderOpenCodePlugin({
      projectId: identity.id,
      transport: options.transport,
      home: options.home,
      url: options.url,
      tokenEnv: options.tokenEnv,
      executable: executable(options),
      tenantId: options.tenantId,
      ownerId: options.ownerId,
      sensitivities: options.sensitivities,
    });
    const topology = metadata || {
      version: 1,
      projectId: identity.id,
      config: originalFileTopology(configPath, configCurrent),
      directories: {
        opencode: existsSync(join(options.projectDir, ".opencode")),
        plugins: existsSync(join(options.projectDir, ".opencode", "plugins")),
      },
    };
    const ownership = {
      version: 1,
      projectId: identity.id,
      pluginSha256: sha256(core),
      config: { state: topology.config.state, sha256: topology.config.sha256, generated: sha256(configContent) },
      directories: topology.directories,
    };
    pluginContent = `${OPENCODE_OWNERSHIP_PREFIX}${encodedOpenCodeMetadata(ownership)}\n${core}`;
  } else if (metadata) {
    const restored = restoredLifecycleContent(options, client, configPath, metadata.config);
    configContent = restored.content;
    deleteConfig = restored.deleteTarget;
    deletePlugin = true;
    cleanupDirectories = [
      ...(!metadata.directories.plugins ? [join(options.projectDir, ".opencode", "plugins")] : []),
      ...(!metadata.directories.opencode ? [join(options.projectDir, ".opencode")] : []),
    ];
  } else {
    configContent = configCurrent;
  }

  for (const path of [configPath, pluginPath]) ensureSafeParents(options.projectDir, path, false);
  const unownedDisconnectNoop = action === "disconnect" && !metadata;
  return [{
    client, action, options, path: configPath, content: configContent, original: snapshot(configPath),
    kind: "mcp", owner: "continuitydb-mcp", assetClients: [client], deleteTarget: deleteConfig,
    noOp: unownedDisconnectNoop,
  }, {
    client, action, options, path: pluginPath, content: pluginContent, original: snapshot(pluginPath),
    kind: "plugin", owner: "continuitydb-opencode-plugin", assetClients: [client], deleteTarget: deletePlugin,
    noOp: unownedDisconnectNoop, cleanupDirectories,
  }];
}

function copilotPolicyContent(body, ownership) {
  const firstLineEnd = body.indexOf("\n");
  const metadata = `<!-- continuitydb managed mcp ownership: document=${ownership.document}; namespace=${ownership.namespace}; entry_sha256=${ownership.entrySha256} -->`;
  return `${body.slice(0, firstLineEnd)}\n${metadata}${body.slice(firstLineEnd)}`;
}

function prepareCopilotChanges(rawOptions, action, identity) {
  const client = "copilot";
  const options = normalizeOptions(rawOptions, { identity });
  const policyPath = join(options.projectDir, ".github", "copilot-instructions.md");
  const policyCurrent = readText(policyPath);
  const metadata = dedicatedPolicyMetadata(policyCurrent, client);
  if (action === "connect" && metadata && metadata.projectId !== identity.id) {
    throw new Error(`ContinuityDB managed Copilot policy belongs to project ${metadata.projectId}, not ${identity.id}`);
  }

  const mcpPath = jsonTarget(client, options.projectDir);
  const mcpCurrent = readText(mcpPath);
  const mcpLayout = parseJsonLayout(mcpCurrent, mcpPath);
  const servers = propertyNamed(mcpLayout.root, "servers");
  if (servers && servers.value.type !== "object") {
    throw new Error(`configuration namespace servers must be a JSON object: ${mcpPath}`);
  }
  const existingServer = propertyNamed(servers?.value, "continuitydb");
  if (existingServer && !metadata) {
    const suffix = action === "connect"
      ? "remove or rename it before connecting"
      : "refusing to disconnect it";
    throw new Error(`an unmanaged Copilot continuitydb server already exists; ${suffix}`);
  }
  if (existingServer) {
    const currentFingerprint = sha256(canonicalJson(mcpLayout.value.servers.continuitydb));
    if (metadata.ownership.entrySha256 !== currentFingerprint) {
      throw new Error("Copilot MCP ownership fingerprint mismatch; refusing to replace or remove the current server");
    }
  }

  let mcpContent;
  // Policy metadata describes ownership of the entry that existed when it was
  // written. If that entry is now absent, the current document may have been
  // deleted and recreated by the user, so its topology must be derived anew.
  let ownership = existingServer ? metadata?.ownership || null : null;
  let deleteTarget = false;
  let policyContent;
  if (action === "connect") {
    const connected = connectCopilotJson(mcpCurrent, mcpPath, connection(client, options), ownership);
    mcpContent = connected.content;
    ownership = {
      ...connected.ownership,
      entrySha256: copilotEntryFingerprint(mcpContent, mcpPath),
    };
    const descriptor = policyAssetDescriptors(client, {
      projectDir: options.projectDir,
      projectId: identity.id,
      consumers: [client],
    })[0];
    policyContent = mergeManagedText(policyCurrent, {
      startMarker: POLICY_START,
      endMarker: POLICY_END,
      body: copilotPolicyContent(descriptor.content, ownership),
    });
  } else {
    const disconnected = disconnectCopilotJson(mcpCurrent, mcpPath, ownership);
    mcpContent = disconnected.content;
    deleteTarget = disconnected.deleteTarget;
    policyContent = removeManagedText(policyCurrent, { startMarker: POLICY_START, endMarker: POLICY_END });
  }
  ensureSafeParents(options.projectDir, mcpPath, false);
  ensureSafeParents(options.projectDir, policyPath, false);
  return [{
    client, action, options, path: mcpPath, content: mcpContent, original: snapshot(mcpPath),
    kind: "mcp", owner: "continuitydb-mcp", assetClients: [client], deleteTarget,
    noOp: action === "disconnect" && !existsSync(mcpPath),
  }, {
    client, action, options, path: policyPath, content: policyContent, original: snapshot(policyPath),
    kind: "policy", owner: "continuitydb-copilot-policy", assetClients: [client],
    noOp: action === "disconnect" && !existsSync(policyPath),
  }];
}

function dedicatedPolicyMetadata(current, client) {
  removeManagedText(current, { startMarker: POLICY_START, endMarker: POLICY_END });
  const start = current.indexOf(POLICY_START);
  if (start === -1) return null;
  const end = current.indexOf(POLICY_END, start) + POLICY_END.length;
  const block = current.slice(start, end);
  const firstLineEnd = block.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? block : block.slice(0, firstLineEnd);
  if (firstLine !== `${POLICY_START} consumers: ${client}`) {
    throw new Error(`invalid ContinuityDB managed ${client} policy metadata`);
  }
  const ownershipMatches = [...block.matchAll(/<!-- continuitydb managed mcp ownership: document=(missing|empty|existing); namespace=(created|existing); entry_sha256=([a-f0-9]{64}) -->/g)];
  if (ownershipMatches.length !== 1) {
    throw new Error(`invalid ContinuityDB managed ${client} MCP ownership metadata`);
  }
  const projectMatches = [...block.matchAll(/Project scope: `([^`]+)`\./g)];
  if (projectMatches.length !== 1) {
    throw new Error(`invalid ContinuityDB managed ${client} policy project scope`);
  }
  return {
    projectId: validateProjectId(projectMatches[0][1]),
    ownership: {
      document: ownershipMatches[0][1],
      namespace: ownershipMatches[0][2],
      entrySha256: ownershipMatches[0][3],
    },
  };
}

function prepareLifecycleClientChanges(client, rawOptions, action, identity) {
  const baseOptions = normalizeOptions(rawOptions);
  const policyPath = client === "claude"
    ? join(baseOptions.projectDir, "CLAUDE.md")
    : join(baseOptions.projectDir, ".cursor", "rules", "continuitydb.mdc");
  const policyCurrent = readText(policyPath);
  const metadata = lifecyclePolicyMetadata(policyCurrent, client);
  if (action === "connect" && metadata && metadata.projectId !== identity.id) {
    throw new Error(`ContinuityDB managed ${client} policy belongs to project ${metadata.projectId}, not ${identity.id}`);
  }
  const effectiveIdentity = identity || (metadata
    ? { id: metadata.projectId }
    : { id: validateProjectId(rawOptions.projectId || baseOptions.projects[0]) });
  const options = normalizeOptions(rawOptions, { identity: effectiveIdentity });
  const policyDescriptor = policyAssetDescriptors(client, {
    projectDir: options.projectDir,
    projectId: effectiveIdentity.id,
    consumers: [client],
  })[0];
  const policyCore = lifecyclePolicyCore(client, policyDescriptor.content);
  const policyPrefix = lifecyclePolicyPrefix(client, policyDescriptor.content);
  if (metadata) {
    const expectedManaged = lifecyclePolicyContent(policyCore, {
      mcp: metadata.mcp,
      start: metadata.start,
      stop: metadata.stop,
      policy: metadata.policy,
    }, metadata.topology);
    if (metadata.policy !== sha256(policyCore) || lifecycleManagedBlock(policyCurrent) !== expectedManaged
      || (metadata.topology.policy.prefix && !policyCurrent.startsWith(policyPrefix))) {
      const label = client === "cursor" ? "Cursor rule" : "Claude policy";
      throw new Error(`${label} ownership fingerprint mismatch`);
    }
  }

  const mcpPath = jsonTarget(client, options.projectDir);
  const mcpCurrentText = readText(mcpPath);
  const mcpCurrent = parseJson(mcpPath);
  const mcpNamespace = mcpCurrent.mcpServers === undefined
    ? null
    : managedJsonNamespace(mcpCurrent, "mcpServers", mcpPath);
  const currentMcp = mcpNamespace?.continuitydb;
  const hasCurrentMcp = Boolean(mcpNamespace && Object.prototype.hasOwnProperty.call(mcpNamespace, "continuitydb"));
  if (hasCurrentMcp && !metadata) {
    throw new Error(`an unmanaged ${client} continuitydb server already exists; refusing to ${action}`);
  }
  if (hasCurrentMcp && metadata && entryFingerprint(currentMcp) !== metadata.mcp) {
    throw new Error(`${client} MCP ownership fingerprint mismatch`);
  }
  if (metadata && (!existsSync(mcpPath) || sha256(mcpCurrentText) !== metadata.topology.mcp.generated)) {
    throw new Error(`${client} MCP file ownership fingerprint mismatch`);
  }

  const hooksPath = client === "claude"
    ? join(options.projectDir, ".claude", "settings.json")
    : join(options.projectDir, ".cursor", "hooks.json");
  const hooksCurrentText = readText(hooksPath);
  const hooksCurrent = parseJson(hooksPath);
  if (metadata && (!existsSync(hooksPath) || sha256(hooksCurrentText) !== metadata.topology.hooks.generated)) {
    throw new Error(`${client} hooks file ownership fingerprint mismatch`);
  }
  const renderedHooks = renderLifecycleHooks(client, hooksCurrent, hooksPath, options, metadata, action);
  const unownedDisconnectNoop = action === "disconnect" && !metadata && !hasCurrentMcp;

  const directories = client === "claude"
    ? { claude: existsSync(join(options.projectDir, ".claude")) }
    : {
      cursor: existsSync(join(options.projectDir, ".cursor")),
      rules: existsSync(join(options.projectDir, ".cursor", "rules")),
    };
  const originalTopology = metadata?.topology || {
    mcp: originalFileTopology(mcpPath, mcpCurrentText),
    hooks: originalFileTopology(hooksPath, hooksCurrentText),
    policy: {
      state: existsSync(policyPath) ? (policyCurrent === "" ? "empty" : "existing") : "missing",
      prefix: client === "cursor" && policyCurrent === "",
    },
    directories,
  };

  const connectedMcp = action === "connect"
    ? connectedJson(client, mcpCurrent, options)
    : disconnectedJson(client, mcpCurrent, mcpPath);
  let mcpContent = `${JSON.stringify(connectedMcp, null, 2)}\n`;
  let hooksContent = `${JSON.stringify(renderedHooks.value, null, 2)}\n`;
  let deleteMcp = false;
  let deleteHooks = false;
  let policyContent;
  let deletePolicy = false;
  if (action === "connect") {
    const entries = renderedHooks.generated;
    const names = renderedHooks.names;
    const topology = {
      ...originalTopology,
      mcp: { ...originalTopology.mcp, generated: sha256(mcpContent) },
      hooks: { ...originalTopology.hooks, generated: sha256(hooksContent) },
    };
    const body = lifecyclePolicyContent(policyCore, {
      mcp: entryFingerprint(connectedMcp.mcpServers.continuitydb),
      start: entryFingerprint(entries[names.start]),
      stop: entryFingerprint(entries[names.stop]),
      policy: sha256(policyCore),
    }, topology);
    policyContent = client === "cursor" && originalTopology.policy.prefix && !metadata
      ? `${policyPrefix}${body}`
      : mergeManagedText(policyCurrent, { startMarker: POLICY_START, endMarker: POLICY_END, body });
  } else {
    const restoredMcp = metadata
      ? restoredLifecycleContent(options, client, mcpPath, originalTopology.mcp)
      : { content: mcpContent, deleteTarget: false };
    const restoredHooks = metadata
      ? restoredLifecycleContent(options, client, hooksPath, originalTopology.hooks)
      : { content: hooksContent, deleteTarget: false };
    mcpContent = restoredMcp.content;
    hooksContent = restoredHooks.content;
    deleteMcp = restoredMcp.deleteTarget;
    deleteHooks = restoredHooks.deleteTarget;
    policyContent = removeManagedText(policyCurrent, { startMarker: POLICY_START, endMarker: POLICY_END });
    if (client === "cursor" && originalTopology.policy.prefix && metadata) {
      if (!policyContent.startsWith(policyPrefix)) throw new Error("Cursor rule ownership prefix mismatch");
      policyContent = policyContent.slice(policyPrefix.length);
    }
    deletePolicy = originalTopology.policy.state === "missing" && policyContent === "";
  }

  const cleanupDirectories = action === "disconnect" && metadata
    ? client === "claude"
      ? originalTopology.directories.claude ? [] : [join(options.projectDir, ".claude")]
      : [
        ...(!originalTopology.directories.rules ? [join(options.projectDir, ".cursor", "rules")] : []),
        ...(!originalTopology.directories.cursor ? [join(options.projectDir, ".cursor")] : []),
      ]
    : [];

  for (const path of [mcpPath, hooksPath, policyPath]) ensureSafeParents(options.projectDir, path, false);
  return [{
    client, action, options, path: mcpPath, content: mcpContent, original: snapshot(mcpPath),
    kind: "mcp", owner: "continuitydb-mcp", assetClients: [client], deleteTarget: deleteMcp,
    noOp: unownedDisconnectNoop || (action === "disconnect" && !existsSync(mcpPath)),
  }, {
    client, action, options, path: hooksPath, content: hooksContent, original: snapshot(hooksPath),
    kind: "lifecycle", owner: `continuitydb-${client}-hooks`, assetClients: [client], deleteTarget: deleteHooks,
    noOp: unownedDisconnectNoop || (action === "disconnect" && !existsSync(hooksPath)),
  }, {
    client, action, options, path: policyPath, content: policyContent, original: snapshot(policyPath),
    kind: "policy", owner: policyDescriptor.owner, assetClients: [client], deleteTarget: deletePolicy,
    noOp: unownedDisconnectNoop || (action === "disconnect" && !existsSync(policyPath)), cleanupDirectories,
  }];
}

function hasManagedMcpOnlyTransport(client, projectDir) {
  const path = client === "codex" ? join(projectDir, ".codex", "config.toml") : jsonTarget(client, projectDir);
  if (!existsSync(path)) return false;
  if (client === "codex") return codexManagedMetadata(readText(path))?.metadata?.mode === "mcp-only";
  const entry = jsonMcpEntry(client, path);
  return Boolean(entry && mcpOnlyOwnershipValue(entry));
}

function prepareAgentChanges(client, rawOptions, action, identity = null, mcpOnly = Boolean(rawOptions.mcpOnly)) {
  if (mcpOnly) return [prepareMcpOnlyChange(client, rawOptions, action, identity)];
  if (client === "copilot") return prepareCopilotChanges(rawOptions, action, identity);
  if (client === "opencode") return prepareOpenCodeChanges(rawOptions, action, identity);
  if (client === "claude" || client === "cursor") {
    return prepareLifecycleClientChanges(client, rawOptions, action, identity);
  }
  return [prepareMcpAgentChange(client, rawOptions, action, identity)];
}

function sharedPolicyMetadata(current) {
  // Running the public remover first gives shared policy files the same strict
  // missing/duplicate/nested/reversed marker validation used by all callers.
  removeManagedText(current, { startMarker: POLICY_START, endMarker: POLICY_END });
  const start = current.indexOf(POLICY_START);
  if (start === -1) return null;
  const end = current.indexOf(POLICY_END, start) + POLICY_END.length;
  const block = current.slice(start, end);
  const firstLineEnd = block.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? block : block.slice(0, firstLineEnd);
  const header = firstLine.match(/^<!-- >>> continuitydb managed policy >>> consumers: ([a-z]+(?:,[a-z]+)*)$/);
  if (!header) throw new Error("invalid ContinuityDB managed policy metadata");
  const consumers = header[1].split(",");
  if (consumers.some((consumer) => consumer !== "codex" && consumer !== "opencode")
    || [...new Set(consumers)].sort().join(",") !== header[1]) {
    throw new Error("invalid ContinuityDB managed policy consumers");
  }
  const projectMatches = [...block.matchAll(/Project scope: `([^`]+)`\./g)];
  if (projectMatches.length !== 1) throw new Error("invalid ContinuityDB managed policy project scope");
  const projectId = validateProjectId(projectMatches[0][1]);
  return { consumers, projectId };
}

function prepareSharedPolicyChange(clients, rawOptions, action, identity) {
  const selected = clients.filter((client) => client === "codex" || client === "opencode");
  if (!selected.length) return null;
  const options = normalizeOptions(rawOptions, { identity });
  const path = join(options.projectDir, "AGENTS.md");
  const current = readText(path);
  const metadata = sharedPolicyMetadata(current);
  if (action === "connect" && metadata && metadata.projectId !== identity.id) {
    throw new Error(`ContinuityDB managed policy belongs to project ${metadata.projectId}, not ${identity.id}`);
  }
  const consumers = new Set(metadata?.consumers || []);
  for (const client of selected) {
    if (action === "connect") consumers.add(client);
    else consumers.delete(client);
  }
  const orderedConsumers = [...consumers].sort();
  let content;
  let descriptor = null;
  if (orderedConsumers.length === 0) {
    content = removeManagedText(current, { startMarker: POLICY_START, endMarker: POLICY_END });
  } else {
    const rendererClient = orderedConsumers.includes("codex") ? "codex" : "opencode";
    descriptor = policyAssetDescriptors(rendererClient, {
      projectDir: options.projectDir,
      projectId: action === "connect" ? identity.id : metadata.projectId,
      consumers: orderedConsumers,
    })[0];
    content = mergeManagedText(current, {
      startMarker: POLICY_START,
      endMarker: POLICY_END,
      body: descriptor.content,
    });
  }
  ensureSafeParents(options.projectDir, path, false);
  return {
    client: selected[0],
    action,
    options,
    path,
    content,
    original: snapshot(path),
    kind: "policy",
    owner: descriptor?.owner || "continuitydb-policy",
    assetClients: selected,
    noOp: action === "disconnect" && metadata === null,
  };
}

function applyAgentPlans(plans, { finalize = null, apply = plans[0]?.options.apply ?? false } = {}) {
  if (!plans.length) {
    if (apply && finalize) finalize({ committed: [] });
    return [];
  }
  if (!plans.every((plan) => plan.options.apply === apply)) throw new Error("agent batch must use one apply mode");
  if (!apply) {
    return plans.map((plan) => {
      if (plan.noOp) {
        return publicResult(plan, {
          path: plan.path, changed: false, applied: false, verified: true, backup: null, createdDirectories: [],
        });
      }
      const operationOptions = {
        root: plan.options.projectDir, home: plan.options.home, backupHome: plan.options.backupHome,
        client: plan.client, apply: false, expected: plan.original,
      };
      const result = plan.deleteTarget
        ? atomicRemove(plan.path, operationOptions)
        : atomicWrite(plan.path, plan.content, operationOptions);
      return publicResult(plan, result);
    });
  }

  const releaseBatchLocks = acquireFileLocks(plans.map((plan) => configurationLockPath(plan.path)));
  const committed = [];
  try {
    for (const plan of plans) {
      if (plan.noOp) {
        committed.push({
          plan,
          result: {
            path: plan.path, changed: false, applied: true, verified: true, backup: null, createdDirectories: [],
          },
        });
        continue;
      }
      const createdDirectories = ensureSafeParents(plan.options.projectDir, plan.path, true);
      let result;
      try {
        const operationOptions = {
          root: plan.options.projectDir, home: plan.options.home, backupHome: plan.options.backupHome,
          client: plan.client, apply: true, expected: plan.original,
          beforeReplace: plan.options._testBeforeReplace,
        };
        result = plan.deleteTarget
          ? atomicRemove(plan.path, operationOptions)
          : atomicWrite(plan.path, plan.content, operationOptions);
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
      verifyCommittedAgentPlans(committed);
    }
    if (finalize) finalize({ committed });
    verifyCommittedAgentPlans(committed);
    const values = committed.map(({ plan, result }) => publicResult(plan, result));
    // Remove only empty parents known not to predate the lifecycle adapter. A
    // concurrent user file makes rmdir fail with ENOTEMPTY and is preserved;
    // an unexpected failure enters normal rollback, which recreates parents.
    for (const { plan } of committed) {
      for (const directory of plan.cleanupDirectories || []) {
        try { rmdirSync(directory); }
        catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") {
            throw error;
          }
        }
      }
    }
    return values;
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
  if (!unique.length) {
    return applyAgentPlans([], { finalize: rawOptions._finalizeSetup, apply: Boolean(rawOptions.apply) });
  }
  const projectDir = resolve(rawOptions.projectDir || process.cwd());
  const identity = action === "connect" ? connectorIdentity(projectDir, rawOptions) : null;
  // Phase 1 is deliberately side-effect free. Every parser, namespace, marker,
  // path and rendered output must validate before the first client file changes.
  const mcpOnlyClients = new Set(unique.filter((client) => (
    rawOptions.mcpOnly || (action === "disconnect" && hasManagedMcpOnlyTransport(client, projectDir))
  )));
  const plans = unique.flatMap((client) => (
    prepareAgentChanges(client, rawOptions, action, identity, mcpOnlyClients.has(client))
  ));
  const completeClients = unique.filter((client) => !mcpOnlyClients.has(client));
  const policyPlan = completeClients.length
    ? prepareSharedPolicyChange(completeClients, rawOptions, action, identity)
    : null;
  if (policyPlan) plans.push(policyPlan);
  const results = applyAgentPlans(plans, { finalize: rawOptions._finalizeSetup });
  return unique.map((client) => {
    const indexedAssets = plans
      .map((plan, index) => ({ plan, result: results[index] }))
      .filter(({ plan }) => plan.assetClients.includes(client));
    const primary = indexedAssets.find(({ plan }) => plan.kind === "mcp")?.result;
    const assets = indexedAssets.map(({ result }) => ({
      path: result.path,
      kind: result.kind,
      owner: result.owner,
      changed: result.changed,
      applied: result.applied,
      verified: result.verified,
      backup: result.backup,
    }));
    const capabilities = mcpOnlyClients.has(client)
      ? {
        recall_mode: "mcp-only",
        capture_mode: "explicit-governed",
        limitations: ["MCP-only mode exposes ContinuityDB tools but does not install automatic recall lifecycle or policy assets."],
      }
      : client === "codex" || client === "copilot"
      ? { recall_mode: "policy-led", capture_mode: "explicit-governed", limitations: [] }
      : client === "claude"
        ? { recall_mode: "hook-enforced", capture_mode: "explicit-governed", limitations: [] }
        : client === "cursor"
          ? {
            recall_mode: "hook+policy",
            capture_mode: "explicit-governed",
            limitations: ["Cursor read-only cloud sessions use the always-loaded policy fallback until lifecycle hooks are available."],
          }
          : client === "opencode"
            ? {
              recall_mode: "plugin+policy",
              capture_mode: "explicit-governed",
              limitations: ["OpenCode first-task recall is policy-led; the plugin enforces compaction recall and explicit structured idle handoff only."],
            }
            : {};
    return {
      client,
      selected: true,
      planned: assets.some((asset) => asset.applied !== true),
      project_dir: primary.project_dir,
      path: primary.path,
      changed: assets.some((asset) => asset.changed),
      applied: assets.every((asset) => asset.applied),
      verified: assets.every((asset) => asset.verified),
      backup: primary.backup,
      assets,
      ...capabilities,
    };
  });
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

function connectorCapabilities(client, mcpOnly = false) {
  if (mcpOnly) return {
    recall_mode: "mcp-only",
    capture_mode: "explicit-governed",
    limitations: ["MCP-only mode exposes ContinuityDB tools but does not install automatic recall lifecycle or policy assets."],
  };
  if (client === "codex" || client === "copilot") {
    return { recall_mode: "policy-led", capture_mode: "explicit-governed", limitations: [] };
  }
  if (client === "claude") {
    return { recall_mode: "hook-enforced", capture_mode: "explicit-governed", limitations: [] };
  }
  if (client === "cursor") return {
    recall_mode: "hook+policy",
    capture_mode: "explicit-governed",
    limitations: ["Cursor read-only cloud sessions use the always-loaded policy fallback until lifecycle hooks are available."],
  };
  return {
    recall_mode: "plugin+policy",
    capture_mode: "explicit-governed",
    limitations: ["OpenCode first-task recall is policy-led; the plugin enforces compaction recall and explicit structured idle handoff only."],
  };
}

function statusAsset(path, kind, owner, verify, { expected = true } = {}) {
  if (!expected) return null;
  if (!existsSync(path)) {
    return { path, kind, owner, exists: false, missing: true, changed: false, verified: false, drifted: true };
  }
  try {
    const content = readText(path);
    const verified = Boolean(verify(content));
    return {
      path, kind, owner, exists: true, missing: false, changed: !verified, verified, drifted: !verified,
    };
  } catch (error) {
    return {
      path, kind, owner, exists: true, missing: false, changed: true, verified: false, drifted: true,
      error: error.message,
    };
  }
}

function managedBlockEquals(current, expected) {
  const start = current.indexOf(POLICY_START);
  const end = current.indexOf(POLICY_END, start);
  return start !== -1 && end !== -1
    && current.slice(start, end + POLICY_END.length) === expected.trimEnd();
}

function jsonMcpEntry(client, path) {
  const value = parseJson(path);
  const key = client === "opencode" ? "mcp" : client === "copilot" ? "servers" : "mcpServers";
  if (value[key] === undefined) return null;
  return managedJsonNamespace(value, key, path).continuitydb || null;
}

function validScopedMcpEntry(client, path) {
  const entry = jsonMcpEntry(client, path);
  if (!entry || !isPlainObject(entry)) return false;
  const allowed = entry.env?.CONTINUITYDB_ALLOWED_PROJECTS
    || entry.environment?.CONTINUITYDB_ALLOWED_PROJECTS;
  if (allowed !== undefined) {
    validateProjectId(allowed);
    if (allowed === "default" || allowed.includes("*")) return false;
  }
  return true;
}

function expectedSharedPolicy(current, client, projectDir) {
  const metadata = sharedPolicyMetadata(current);
  if (!metadata?.consumers.includes(client)) return false;
  const rendererClient = metadata.consumers.includes("codex") ? "codex" : "opencode";
  const descriptor = policyAssetDescriptors(rendererClient, {
    projectDir, projectId: metadata.projectId, consumers: metadata.consumers,
  })[0];
  return managedBlockEquals(current, descriptor.content);
}

function lifecycleStatusAssets(client, options, paths) {
  let metadata = null;
  try { metadata = lifecyclePolicyMetadata(readText(paths.policy), client); }
  catch { /* The policy asset reports the specific parsing failure below. */ }
  const policy = statusAsset(paths.policy, "policy", `continuitydb-${client}-policy`, (current) => {
    const value = lifecyclePolicyMetadata(current, client);
    if (!value) return false;
    const descriptor = policyAssetDescriptors(client, {
      projectDir: options.projectDir, projectId: value.projectId, consumers: [client],
    })[0];
    const core = lifecyclePolicyCore(client, descriptor.content);
    const expected = lifecyclePolicyContent(core, {
      mcp: value.mcp, start: value.start, stop: value.stop, policy: value.policy,
    }, value.topology);
    return value.policy === sha256(core)
      && lifecycleManagedBlock(current) === expected
      && (!value.topology.policy.prefix || current.startsWith(lifecyclePolicyPrefix(client, descriptor.content)));
  });
  const mcp = statusAsset(paths.mcp, "mcp", "continuitydb-mcp", (current) => {
    if (!metadata || sha256(current) !== metadata.topology.mcp.generated) return false;
    const entry = jsonMcpEntry(client, paths.mcp);
    return Boolean(entry) && entryFingerprint(entry) === metadata.mcp && validScopedMcpEntry(client, paths.mcp);
  });
  const hooks = statusAsset(paths.hooks, "lifecycle", `continuitydb-${client}-hooks`, (current) => {
    if (!metadata || sha256(current) !== metadata.topology.hooks.generated) return false;
    const value = parseJson(paths.hooks);
    const names = lifecycleEventNames(client);
    return findOwnedHookIndex(value.hooks?.[names.start] || [], metadata.start) !== -1
      && findOwnedHookIndex(value.hooks?.[names.stop] || [], metadata.stop) !== -1;
  });
  return [mcp, hooks, policy];
}

function registeredProjectForStatus(home, projectId) {
  const path = join(home, "config.json");
  if (!existsSync(path)) return null;
  const config = JSON.parse(readText(path));
  if (!isPlainObject(config) || (config.projects !== undefined && !Array.isArray(config.projects))) {
    throw new Error("vault config projects must be an array");
  }
  let match = null;
  const seen = new Set();
  for (const project of config.projects || []) {
    if (!isPlainObject(project)) throw new Error("registered project must be an object");
    const id = validateProjectId(project.id);
    if (seen.has(id)) throw new Error(`project ${id} is registered more than once`);
    seen.add(id);
    if (typeof project.root !== "string" || !isAbsolute(project.root)) {
      throw new Error(`registered project root must be an absolute path: ${id}`);
    }
    if (project.source !== "git" && project.source !== "explicit") {
      throw new Error(`registered project source must be git or explicit: ${id}`);
    }
    if (id === projectId) match = { id, root: resolve(project.root), source: project.source };
  }
  return match;
}

export function connectionStatus(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  let statusIdentity = null;
  let identityError = null;
  try {
    statusIdentity = connectorIdentity(options.projectDir, rawOptions);
    const registered = registeredProjectForStatus(options.home, statusIdentity.id);
    if (!registered) {
      identityError = `project ${statusIdentity.id} is not registered for status verification`;
    } else if (resolve(registered.root) !== resolve(statusIdentity.root)) {
      identityError = `project ${statusIdentity.id} is registered at ${registered.root}, not current root ${statusIdentity.root}`;
    }
  } catch (error) {
    identityError = error.message;
  }
  return SUPPORTED_AGENTS.map((client) => {
    const mcpPath = client === "codex" ? join(options.projectDir, ".codex", "config.toml") : jsonTarget(client, options.projectDir);
    try {
      let connected = false;
      let mcpOnly = false;
      let mcpOnlyMetadata = null;
      let managedProjectId = null;
      if (client === "codex") {
        if (existsSync(mcpPath)) {
          const text = readText(mcpPath);
          validateToml(text, mcpPath);
          const ownership = codexManagedMetadata(text);
          connected = ownership !== null;
          mcpOnly = ownership?.metadata?.mode === "mcp-only";
          managedProjectId = ownership?.metadata?.projectId || null;
        }
      } else if (existsSync(mcpPath)) {
        const entry = jsonMcpEntry(client, mcpPath);
        connected = Boolean(entry);
        if (entry) {
          const encoded = mcpOnlyOwnershipValue(entry);
          mcpOnly = Boolean(encoded);
          if (encoded) {
            try { mcpOnlyMetadata = verifiedMcpOnlyMetadata(entry, readText(mcpPath)); }
            catch { mcpOnlyMetadata = { projectId: null }; }
            managedProjectId = mcpOnlyMetadata.projectId;
          } else {
            managedProjectId = entry.env?.CONTINUITYDB_ALLOWED_PROJECTS
              || entry.environment?.CONTINUITYDB_ALLOWED_PROJECTS
              || null;
          }
        }
      }
      let completeOwnership = false;
      if (!connected) {
        try {
          if (client === "codex") {
            completeOwnership = expectedSharedPolicy(readText(join(options.projectDir, "AGENTS.md")), client, options.projectDir);
          } else if (client === "claude" || client === "cursor") {
            const policyPath = client === "claude"
              ? join(options.projectDir, "CLAUDE.md")
              : join(options.projectDir, ".cursor", "rules", "continuitydb.mdc");
            const hooksPath = client === "claude"
              ? join(options.projectDir, ".claude", "settings.json")
              : join(options.projectDir, ".cursor", "hooks.json");
            completeOwnership = Boolean(lifecyclePolicyMetadata(readText(policyPath), client))
              || (existsSync(hooksPath) && looksLikeContinuityHook(parseJson(hooksPath)));
          } else if (client === "opencode") {
            completeOwnership = Boolean(opencodePluginMetadata(readText(join(
              options.projectDir, ".opencode", "plugins", "continuitydb.js",
            )))) || expectedSharedPolicy(readText(join(options.projectDir, "AGENTS.md")), client, options.projectDir);
          } else {
            completeOwnership = Boolean(dedicatedPolicyMetadata(readText(
              join(options.projectDir, ".github", "copilot-instructions.md"),
            ), client));
          }
        } catch {
          // Malformed remaining managed assets are still evidence of drift when
          // their ContinuityDB markers or lifecycle commands are present.
          const candidates = client === "codex" || client === "opencode"
            ? [join(options.projectDir, "AGENTS.md")]
            : client === "claude"
              ? [join(options.projectDir, "CLAUDE.md"), join(options.projectDir, ".claude", "settings.json")]
              : client === "cursor"
                ? [join(options.projectDir, ".cursor", "rules", "continuitydb.mdc"), join(options.projectDir, ".cursor", "hooks.json")]
                : [join(options.projectDir, ".github", "copilot-instructions.md")];
          completeOwnership = candidates.some((path) => {
            try { return existsSync(path) && /continuitydb/i.test(readText(path)); } catch { return true; }
          });
        }
      }
      if (!connected && !completeOwnership) {
        return {
          client, connected: false, path: mcpPath, verified: false, drifted: false, assets: [],
          ...connectorCapabilities(client, false),
        };
      }

      let assets;
      if (mcpOnly) {
        assets = [statusAsset(mcpPath, "mcp", "continuitydb-mcp-only", (current) => {
          if (client === "codex") {
            validateToml(current, mcpPath);
            const ownership = codexManagedMetadata(current, { allowLegacy: false });
            const allowed = ownership?.entry?.env?.CONTINUITYDB_ALLOWED_PROJECTS;
            return ownership?.metadata?.mode === "mcp-only"
              && allowed !== "default" && allowed !== "*";
          }
          const entry = jsonMcpEntry(client, mcpPath);
          const verified = entry && verifiedMcpOnlyMetadata(entry, current);
          return Boolean(verified) && (!mcpOnlyMetadata.projectId || verified.projectId === mcpOnlyMetadata.projectId)
            && validScopedMcpEntry(client, mcpPath);
        })];
      } else if (client === "claude" || client === "cursor") {
        const policyPath = client === "claude"
          ? join(options.projectDir, "CLAUDE.md")
          : join(options.projectDir, ".cursor", "rules", "continuitydb.mdc");
        try { managedProjectId = lifecyclePolicyMetadata(readText(policyPath), client)?.projectId || managedProjectId; }
        catch { /* The policy asset reports malformed ownership below. */ }
        assets = lifecycleStatusAssets(client, options, {
          mcp: mcpPath,
          hooks: client === "claude"
            ? join(options.projectDir, ".claude", "settings.json")
            : join(options.projectDir, ".cursor", "hooks.json"),
          policy: policyPath,
        });
      } else if (client === "opencode") {
        const pluginPath = join(options.projectDir, ".opencode", "plugins", "continuitydb.js");
        const policyPath = join(options.projectDir, "AGENTS.md");
        let metadata = null;
        try { metadata = opencodePluginMetadata(readText(pluginPath)); } catch { /* reported by asset */ }
        try {
          managedProjectId = metadata?.projectId
            || sharedPolicyMetadata(readText(policyPath))?.projectId
            || managedProjectId;
        } catch { /* The affected asset reports malformed ownership below. */ }
        assets = [
          statusAsset(mcpPath, "mcp", "continuitydb-mcp", (current) => (
            Boolean(metadata) && sha256(current) === metadata.config.generated && validScopedMcpEntry(client, mcpPath)
          )),
          statusAsset(pluginPath, "plugin", "continuitydb-opencode-plugin", (current) => Boolean(opencodePluginMetadata(current))),
          statusAsset(policyPath, "policy", "continuitydb-policy", (current) => expectedSharedPolicy(current, client, options.projectDir)),
        ];
      } else if (client === "copilot") {
        const policyPath = join(options.projectDir, ".github", "copilot-instructions.md");
        let metadata = null;
        try { metadata = dedicatedPolicyMetadata(readText(policyPath), client); } catch { /* reported by asset */ }
        managedProjectId = metadata?.projectId || managedProjectId;
        assets = [
          statusAsset(mcpPath, "mcp", "continuitydb-mcp", () => {
            const entry = jsonMcpEntry(client, mcpPath);
            return Boolean(metadata && entry)
              && entryFingerprint(entry) === metadata.ownership.entrySha256
              && validScopedMcpEntry(client, mcpPath);
          }),
          statusAsset(policyPath, "policy", "continuitydb-copilot-policy", (current) => {
            const value = dedicatedPolicyMetadata(current, client);
            if (!value) return false;
            const descriptor = policyAssetDescriptors(client, {
              projectDir: options.projectDir, projectId: value.projectId, consumers: [client],
            })[0];
            return managedBlockEquals(current, copilotPolicyContent(descriptor.content, value.ownership));
          }),
        ];
      } else {
        const policyPath = join(options.projectDir, "AGENTS.md");
        try { managedProjectId = sharedPolicyMetadata(readText(policyPath))?.projectId || managedProjectId; }
        catch { /* The policy asset reports malformed ownership below. */ }
        assets = [
          statusAsset(mcpPath, "mcp", "continuitydb-mcp", (current) => {
            validateToml(current, mcpPath);
            const ownership = codexManagedMetadata(current, { allowLegacy: false });
            const allowed = ownership?.entry?.env?.CONTINUITYDB_ALLOWED_PROJECTS;
            return ownership?.metadata?.mode === "complete"
              && allowed !== "default" && allowed !== "*";
          }),
          statusAsset(policyPath, "policy", "continuitydb-policy", (current) => expectedSharedPolicy(current, client, options.projectDir)),
        ];
      }
      const projectMismatch = managedProjectId && statusIdentity && managedProjectId !== statusIdentity.id
        ? `managed ${client} adapter belongs to project ${managedProjectId}, not current project ${statusIdentity.id}`
        : null;
      const scopeError = identityError || projectMismatch;
      const verified = assets.every((asset) => asset.verified) && !scopeError;
      return {
        client,
        connected,
        path: mcpPath,
        verified,
        drifted: !verified,
        assets,
        ...(scopeError ? { error: scopeError } : {}),
        ...connectorCapabilities(client, mcpOnly),
      };
    } catch (error) {
      return {
        client, connected: false, path: mcpPath, verified: false, drifted: true, assets: [], error: error.message,
        ...connectorCapabilities(client, false),
      };
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
