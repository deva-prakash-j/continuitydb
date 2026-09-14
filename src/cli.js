#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ContextVault } from "./store.js";
import { createContinuityServer } from "./http-server.js";
import { scanRepository } from "./repo-ingest.js";
import { CapturePolicy, loadCapturePolicy } from "./capture-policy.js";
import { normalizeIdentity } from "./security.js";
import { createEmbedderFromEnv, HybridEngine, normalizeSearchRequest } from "./embeddings.js";
import { buildRepositoryGraph } from "./graph/repository-graph.js";
import {
  acquireLocalModelCacheLock,
  BUILTIN_LOCAL_MODEL,
  ensureLocalModel,
  localModelStatus,
} from "./local-embeddings.js";
import {
  connectAgents,
  connectionStatus,
  detectAgents,
  disconnectAgents,
  setupAgentSummary,
  SUPPORTED_AGENTS,
} from "./agent-connectors.js";
import { isStandaloneBinary } from "./binary-runtime.js";
import { installStandaloneBinary } from "./self-install.js";
import { VERSION } from "./version.js";
import { defaultDataHome, hasPrivateDirectoryPermissions } from "./paths.js";
import { acquireVaultInitializationLock } from "./file-lock.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { listRegisteredProjects, registerProject } from "./project-registry.js";
import { ensureTrustedProject } from "./trusted-project.js";
import {
  globalOpenCodeStatus,
  installGlobalOpenCode,
  uninstallGlobalOpenCode,
} from "./opencode-global-install.js";

function parse(argv) {
  const positional = [];
  const flags = {};
  const repeatable = new Set(["workspace_root"]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    let value;
    if (inline !== undefined) value = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) value = argv[++index];
    else value = true;
    if (flags[key] === undefined || !repeatable.has(key)) flags[key] = value;
    else flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
  }
  return { positional, flags };
}

function numberFlag(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected a number, received ${value}`);
  return parsed;
}

function listFlag(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim()).filter(Boolean);
}

function output(value, pretty = true) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function usage() {
  process.stdout.write(`ContinuityDB — portable context graph for AI agents

Usage:
  continuitydb version
  continuitydb install [--prefix PATH] --apply
  continuitydb setup [--agents detected|all|A,B] [--project-dir PATH] [--project ID] [--mcp-only] [--apply]
  continuitydb init [--home PATH]
  continuitydb doctor [--home PATH]
  continuitydb run [--home PATH] [--host HOST] [--port PORT] [--review-ui]
  continuitydb agents detect
  continuitydb agents status [--project-dir PATH]
  continuitydb agents connect AGENT|all [--project-dir PATH] [--project ID] [--transport stdio|http] [--url URL] [--mcp-only] --apply
  continuitydb agents disconnect AGENT|all [--project-dir PATH] [--mcp-only] --apply
  continuitydb projects list [--home PATH]
  continuitydb projects add --project-dir PATH [--project ID] [--home PATH] [--apply]
  continuitydb opencode install --workspace-root PATH [--workspace-root PATH ...] [--opencode-config-dir PATH] [--home PATH] [--apply]
  continuitydb opencode ensure --project-dir PATH --workspace-root PATH [--workspace-root PATH ...] [--home PATH] --apply
  continuitydb opencode status [--opencode-config-dir PATH]
  continuitydb opencode uninstall [--opencode-config-dir PATH] [--apply]
  continuitydb mcp [--home PATH]
  continuitydb hook session-start|checkpoint [HOOK OPTIONS]
  continuitydb propose --body TEXT [--project ID] [--title TEXT] [--idempotency-key KEY]
  continuitydb capture --body TEXT --project ID [--kind working|inference|git-fact|decision]
  continuitydb commit MEMORY_ID
  continuitydb correct MEMORY_ID [--body TEXT | --handoff-file HANDOFF.json] [--reason TEXT]
  continuitydb search QUERY|--query QUERY [--project ID] [--allow-projects A,B] [--top-k N] [--mode MODE] [--depth 0..3]
  continuitydb context TASK [--project ID] [--allow-projects A,B] [--token-budget N]
  continuitydb graph build --repo PATH --project ID [--apply]
  continuitydb graph status --project ID [--branch REF]
  continuitydb graph explain --project ID --node QUALIFIED_NAME [--branch REF]
  continuitydb graph path --project ID --from QUALIFIED_NAME --to QUALIFIED_NAME [--branch REF]
  continuitydb handoff-save --file HANDOFF.json
  continuitydb handoff-latest TASK_ID --project ID [--branch REF]
  continuitydb link-project SOURCE TARGET --provenance TEXT [--relation depends-on]
  continuitydb link-memory SOURCE_ID TARGET_ID --relation RELATION --provenance TEXT
  continuitydb forget MEMORY_ID
  continuitydb feedback MEMORY_ID --signal helpful|incorrect|outdated [--reason TEXT]
  continuitydb stats
  continuitydb export [--output FILE]
  continuitydb audit-verify
  continuitydb repo-scan PATH [--project ID] [--since COMMIT] [--ingest] [--commit]
  continuitydb embeddings-status [--cache PATH]
  continuitydb embeddings-pull [--cache PATH]
  continuitydb embeddings-index [--limit N] [--batch-size N]

All finite commands emit JSON. Agent-facing capture is governed by server policy;
commit, correct, delete and graph administration remain unavailable over MCP.
`);
}

const rawArguments = process.argv.slice(2);
const { positional, flags } = parse(rawArguments);
const command = positional.shift();
const home = resolve(flags.home || defaultDataHome());
const cliTenantId = process.env.CONTINUITYDB_TENANT_ID || "local";
const cliPrincipalId = process.env.CONTINUITYDB_PRINCIPAL_ID || "local-user";
const cliOwnerId = process.env.CONTINUITYDB_OWNER_ID || cliPrincipalId;
const cliAgentId = process.env.CONTINUITYDB_AGENT_ID || null;

if (!command || command === "help" || flags.help) {
  usage();
  process.exit(0);
}

function agentSelection(value, detectedAgents = null) {
  const requested = listFlag(value || "detected");
  if (requested.includes("all")) return [...SUPPORTED_AGENTS];
  if (requested.includes("detected")) {
    const detection = detectedAgents || detectAgents();
    return detection.filter((item) => item.installed).map((item) => item.client);
  }
  const unsupported = requested.filter((item) => !SUPPORTED_AGENTS.includes(item));
  if (unsupported.length) throw new Error(`unsupported agents: ${unsupported.join(", ")}`);
  return [...new Set(requested)];
}

function agentOptions() {
  return {
    home,
    projectDir: resolve(flags.project_dir || process.cwd()),
    binary: flags.binary || null,
    ownerId: flags.owner || cliOwnerId,
    tenantId: flags.tenant || cliTenantId,
    projectId: flags.project,
    sensitivities: listFlag(flags.sensitivities || "public,private"),
    transport: flags.transport || "stdio",
    url: flags.url,
    tokenEnv: flags.token_env,
    apply: Boolean(flags.apply),
    mcpOnly: Boolean(flags.mcp_only),
  };
}

function withDetection(connections, detectedAgents) {
  const detection = new Map(detectedAgents.map((item) => [item.client, item]));
  return connections.map((item) => {
    const found = detection.get(item.client);
    const detected = Boolean(found?.installed);
    const limitations = [...(item.limitations || [])];
    if (!detected) {
      limitations.push(`The ${item.client} executable was not detected on PATH; install it before using this generated adapter.`);
    }
    return {
      ...item,
      selected: true,
      planned: item.applied !== true,
      detected,
      detected_executable: found?.executable || null,
      limitations,
    };
  });
}

function assertSetupHome(path) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`setup home must be a real directory, not a symlink: ${path}`);
  }
}

function assertSetupDirectory(path, description) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory, not a symlink: ${path}`);
  }
}

function setupFileSnapshot(path, description = "setup file") {
  if (!existsSync(path)) return { existed: false, bytes: null, mode: null };
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${description} must be a regular file, not a symlink: ${path}`);
  }
  return { existed: true, bytes: readFileSync(path), mode: metadata.mode & 0o777 };
}

function sameSetupFile(path, expected) {
  if (!existsSync(path)) return !expected.existed;
  if (!expected.existed) return false;
  const metadata = lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink()
    && (metadata.mode & 0o777) === expected.mode
    && readFileSync(path).equals(expected.bytes);
}

function setupFailpoint(name) {
  if (process.env.CONTINUITYDB_TEST_SETUP_FAILPOINT !== name) return;
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setup failpoints are available only in tests");
  }
  throw new Error(`injected setup failure at ${name}`);
}

function promoteMissingSetupPath(source, target, name) {
  setupFailpoint(`before-${name}`);
  if (existsSync(target)) throw new Error(`setup promotion target appeared concurrently: ${target}`);
  renameSync(source, target);
  setupFailpoint(`after-${name}`);
}

function inspectExistingVault(home) {
  const databasePath = join(home, "index", "context-vault.db");
  if (!existsSync(databasePath)) return null;
  const metadata = lstatSync(databasePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`vault database must be a regular file, not a symlink: ${databasePath}`);
  }
  const vault = new ContextVault(home, { readOnly: true });
  try {
    return vault.stats();
  } finally {
    vault.close();
  }
}

async function synchronizeSetupStagingForTest(prepared) {
  if (process.env.CONTINUITYDB_TEST_SETUP_SNAPSHOT_SYNC !== "1") return;
  if (process.env.NODE_ENV !== "test" || typeof process.send !== "function") {
    throw new Error("setup staging synchronization is available only to IPC test children");
  }
  process.send({ type: "continuitydb:setup-snapshot", directory: prepared.staging });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for setup staging test resume")), 30_000);
    process.once("message", (message) => {
      clearTimeout(timeout);
      if (message !== "continuitydb:resume-setup") {
        reject(new Error("invalid setup staging test resume message"));
        return;
      }
      resolve();
    });
  });
}

function setupConfig(flags) {
  return {
    schema_version: 2,
    mode: "local",
    tenant_id: flags.tenant || cliTenantId,
    owner_id: flags.owner || cliOwnerId,
    created_at: new Date().toISOString(),
  };
}

function discardPreparedSetup(prepared) {
  for (const directory of new Set([prepared?.staging, prepared?.modelStaging].filter(Boolean))) {
    try {
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    } catch {
      // Private staging residue is safe and retryable. Cleanup failure must not
      // turn a committed setup into a reported transaction failure.
    }
  }
}

function createConfiguredModelStaging(cachePath) {
  const target = resolve(cachePath);
  if (existsSync(target)) {
    assertSetupDirectory(target, "configured local model cache");
    assertSetupDirectory(dirname(target), "configured local model cache parent");
    const staging = mkdtempSync(join(dirname(target), `.${basename(target)}.setup-`));
    chmodSync(staging, 0o700);
    const stagedCache = join(staging, "cache");
    mkdirSync(stagedCache, { mode: 0o700 });
    return { staging, stagedCache, sourcePromotionRoot: null, targetPromotionRoot: null };
  }

  let targetPromotionRoot = target;
  while (!existsSync(dirname(targetPromotionRoot))) {
    const parent = dirname(targetPromotionRoot);
    if (parent === targetPromotionRoot) throw new Error(`configured local model cache has no existing parent: ${target}`);
    targetPromotionRoot = parent;
  }
  const existingParent = dirname(targetPromotionRoot);
  assertSetupDirectory(existingParent, "configured local model cache parent");
  const staging = mkdtempSync(join(existingParent, `.${basename(targetPromotionRoot)}.setup-`));
  chmodSync(staging, 0o700);
  const sourcePromotionRoot = join(staging, basename(targetPromotionRoot));
  const stagedCache = join(sourcePromotionRoot, relative(targetPromotionRoot, target));
  mkdirSync(stagedCache, { recursive: true, mode: 0o700 });
  return { staging, stagedCache, sourcePromotionRoot, targetPromotionRoot };
}

async function prepareSetupHome(home, flags, identity) {
  assertSetupHome(home);
  const existed = existsSync(home);
  const recordsPath = join(home, "records");
  const indexPath = join(home, "index");
  if (existed) {
    assertSetupDirectory(recordsPath, "vault records directory");
    assertSetupDirectory(indexPath, "vault index directory");
  }
  const configPath = join(home, "config.json");
  const configBefore = setupFileSnapshot(configPath, "vault config");
  const databasePath = join(indexPath, "context-vault.db");
  const databaseExisted = existsSync(databasePath);
  if (!databaseExisted) {
    const orphanedSidecars = [`${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync);
    if (orphanedSidecars.length) {
      throw new Error(`refusing to initialize a database beside pre-existing SQLite sidecar state without its database: ${orphanedSidecars.join(", ")}`);
    }
  }
  const existingStats = databaseExisted ? inspectExistingVault(home) : null;
  const configuredCache = flags.cache || process.env.CONTINUITYDB_MODEL_CACHE;
  mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(home), `.${basename(home)}.setup-`));
  chmodSync(staging, 0o700);
  let modelStaging = null;

  try {
    const stagedConfigPath = join(staging, "config.json");
    if (configBefore.existed) {
      writeFileSync(stagedConfigPath, configBefore.bytes, { flag: "wx", mode: configBefore.mode ?? 0o600 });
    } else {
      writeFileSync(stagedConfigPath, `${JSON.stringify(setupConfig(flags), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    const registration = registerProject(staging, identity, { apply: true });
    let stats = existingStats;
    if (databaseExisted) {
      mkdirSync(join(staging, "records"), { mode: 0o700 });
      mkdirSync(join(staging, "index"), { mode: 0o700 });
    } else {
      let vault;
      try {
        vault = new ContextVault(staging);
        stats = vault.stats();
      } finally {
        vault?.close();
      }
      const stagedDatabase = join(staging, "index", "context-vault.db");
      const stagedSidecars = [`${stagedDatabase}-wal`, `${stagedDatabase}-shm`].filter(existsSync);
      if (stagedSidecars.length) {
        throw new Error(`staged vault database did not close without SQLite sidecars: ${stagedSidecars.join(", ")}`);
      }
    }

    let embeddings = null;
    let model = null;
    if (flags.semantic) {
      if (configuredCache) {
        const resolvedCache = resolve(configuredCache);
        assertSetupDirectory(resolvedCache, "configured local model cache");
      } else if (existed) {
        assertSetupDirectory(join(home, "models"), "local model cache");
      }
      const current = localModelStatus({ home, cacheDir: configuredCache });
      if (current.ready) {
        embeddings = current;
      } else {
        let staged;
        let configuredStaging = null;
        if (configuredCache) {
          configuredStaging = createConfiguredModelStaging(configuredCache);
          modelStaging = configuredStaging.staging;
          staged = await ensureLocalModel({ home: staging, cacheDir: configuredStaging.stagedCache });
        } else {
          staged = await ensureLocalModel({ home: staging });
        }
        model = {
          sourceDirectory: staged.directory,
          sourceBase: dirname(staged.directory),
          targetDirectory: current.directory,
          targetBase: dirname(current.directory),
          sourcePromotionRoot: configuredStaging?.sourcePromotionRoot || null,
          targetPromotionRoot: configuredStaging?.targetPromotionRoot || null,
        };
        embeddings = staged;
      }
    }
    return {
      home,
      existed,
      staging,
      modelStaging,
      configuredCache,
      recordsExisted: existsSync(recordsPath),
      indexExisted: existsSync(indexPath),
      databaseExisted,
      configBefore,
      registration,
      stats,
      embeddings,
      model,
    };
  } catch (error) {
    discardPreparedSetup({ staging, modelStaging });
    throw error;
  }
}

function promotePreparedModel(prepared) {
  if (!prepared.model || (!prepared.existed && !prepared.configuredCache)) return;
  const {
    sourceBase,
    sourceDirectory,
    sourcePromotionRoot,
    targetBase,
    targetDirectory,
    targetPromotionRoot,
  } = prepared.model;
  if (!existsSync(targetBase)) {
    promoteMissingSetupPath(
      sourcePromotionRoot || sourceBase,
      targetPromotionRoot || targetBase,
      "model-cache",
    );
  } else {
    assertSetupDirectory(targetBase, "local model cache");
    if (!existsSync(targetDirectory)) {
      promoteMissingSetupPath(sourceDirectory, targetDirectory, "model-directory");
    } else {
      assertSetupDirectory(targetDirectory, "local model cache directory");
      const current = localModelStatus({ home: prepared.home, cacheDir: prepared.configuredCache });
      for (const artifact of BUILTIN_LOCAL_MODEL.artifacts) {
        const target = join(targetDirectory, artifact.name);
        const existing = current.artifacts.find((item) => item.name === artifact.name);
        if (existsSync(target)) {
          if (!existing?.ready) throw new Error(`refusing to replace pre-existing local model cache artifact: ${target}`);
          continue;
        }
        promoteMissingSetupPath(join(sourceDirectory, artifact.name), target, `model-${artifact.name}`);
      }
    }
  }
  prepared.embeddings = localModelStatus({ home: prepared.home, cacheDir: prepared.configuredCache });
  if (!prepared.embeddings.ready) throw new Error("local embedding model promotion did not complete");
}

function restoreSetupConfig(path, snapshot) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.restore`);
  try {
    writeFileSync(temporary, snapshot.bytes, { flag: "wx", mode: snapshot.mode ?? 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary);
    throw error;
  }
}

function promoteSetupConfig(prepared) {
  if (!prepared.registration.changed) return;
  const path = join(prepared.home, "config.json");
  if (!sameSetupFile(path, prepared.configBefore)) {
    throw new Error(`setup config changed after preparation: ${path}`);
  }
  setupFailpoint("before-config");
  renameSync(join(prepared.staging, "config.json"), path);
  try {
    setupFailpoint("after-config");
  } catch (error) {
    if (!prepared.configBefore.existed) throw error;
    try { restoreSetupConfig(path, prepared.configBefore); }
    catch (restoreError) {
      throw new AggregateError([error, restoreError], "setup config promotion failed and atomic restoration was incomplete");
    }
    throw error;
  }
}

function promotePreparedSetup(prepared) {
  if (!prepared.existed) {
    promotePreparedModel(prepared);
    setupFailpoint("before-home");
    if (existsSync(prepared.home)) {
      throw new Error(`setup home appeared while initialization was in progress: ${prepared.home}`);
    }
    renameSync(prepared.staging, prepared.home);
    if (prepared.model && !prepared.configuredCache) {
      prepared.embeddings = localModelStatus({ home: prepared.home });
    }
    setupFailpoint("after-home");
    return;
  }

  if (!prepared.recordsExisted) {
    promoteMissingSetupPath(join(prepared.staging, "records"), join(prepared.home, "records"), "records");
  }
  if (!prepared.indexExisted) {
    promoteMissingSetupPath(join(prepared.staging, "index"), join(prepared.home, "index"), "index");
  } else if (!prepared.databaseExisted) {
    promoteMissingSetupPath(
      join(prepared.staging, "index", "context-vault.db"),
      join(prepared.home, "index", "context-vault.db"),
      "database",
    );
  }
  promotePreparedModel(prepared);
  // Config is the commit point for an existing home. Its staged file already
  // has final permissions, and no fallible production step follows the atomic
  // replacement.
  promoteSetupConfig(prepared);
}

try {
  if (command === "version") {
    output({ version: VERSION, standalone: isStandaloneBinary(), node: process.version, platform: process.platform, arch: process.arch });
  } else if (command === "install") {
    output(installStandaloneBinary({ prefix: flags.prefix, apply: Boolean(flags.apply), force: Boolean(flags.force) }));
  } else if (command === "setup") {
    const requestedAgents = flags.agents ? String(flags.agents) : "detected";
    const detectedAgents = detectAgents();
    const selected = agentSelection(requestedAgents, detectedAgents);
    const projectDir = resolve(flags.project_dir || process.cwd());
    const identity = resolveProjectIdentity({ projectDir, explicitProject: flags.project });
    const connectionOptions = { ...agentOptions(), projectId: identity.id };
    const previewRegistration = registerProject(home, identity, { apply: false });
    // Setup must fail without touching the global vault when any client
    // configuration cannot be parsed or safely rendered.
    const previewConnections = withDetection(
      connectAgents(selected, { ...connectionOptions, apply: false }),
      detectedAgents,
    );
    const configPath = join(home, "config.json");
    if (!connectionOptions.apply) {
      output({
        setup: true,
        preview: true,
        home,
        config: configPath,
        stats: null,
        project: identity,
        agents: setupAgentSummary({ requested: requestedAgents, detectedAgents, connections: previewConnections }),
        configuration_scope: "project",
        detected_agents: detectedAgents,
        connections: previewConnections,
        agent_setup: { capture_mode: "explicit-governed", mcp_only: connectionOptions.mcpOnly },
        registration: previewRegistration,
        embeddings: flags.semantic ? { planned: true, provider: "local" } : null,
        applied: false,
        run: { command: isStandaloneBinary() ? process.execPath : "continuitydb", args: ["run", "--home", home] },
      });
      process.exit(0);
    }

    const releaseInitializationLock = acquireVaultInitializationLock(home);
    const configuredCache = flags.cache || process.env.CONTINUITYDB_MODEL_CACHE;
    let releaseModelCacheLock = null;
    let prepared = null;
    try {
      releaseModelCacheLock = flags.semantic
        ? acquireLocalModelCacheLock({ home, cacheDir: configuredCache })
        : null;
      prepared = await prepareSetupHome(home, flags, identity);
      await synchronizeSetupStagingForTest(prepared);
      // Connector phase 1 runs against every selected client before its first
      // write. The finalizer executes while all connector locks remain held;
      // any vault promotion error therefore enters the connector batch's
      // existing reverse rollback path.
      const connections = withDetection(connectAgents(selected, {
        ...connectionOptions,
        backupHome: prepared.existed ? home : prepared.staging,
        _finalizeSetup: () => promotePreparedSetup(prepared),
      }), detectedAgents);
      output({
        setup: true,
        home,
        config: configPath,
        stats: prepared.stats,
        project: identity,
        agents: setupAgentSummary({ requested: requestedAgents, detectedAgents, connections }),
        configuration_scope: "project",
        detected_agents: detectedAgents,
        connections,
        agent_setup: { capture_mode: "explicit-governed", mcp_only: connectionOptions.mcpOnly },
        registration: prepared.registration,
        embeddings: prepared.embeddings,
        applied: Boolean(flags.apply),
        run: { command: isStandaloneBinary() ? process.execPath : "continuitydb", args: ["run", "--home", home] },
      });
    } finally {
      try { discardPreparedSetup(prepared); }
      finally {
        try { if (releaseModelCacheLock) releaseModelCacheLock(); }
        finally { releaseInitializationLock(); }
      }
    }
  } else if (command === "projects") {
    const action = positional.shift() || "list";
    if (action === "list") {
      output({ projects: listRegisteredProjects(home) });
    } else if (action === "add") {
      if (!flags.project_dir) throw new Error("projects add requires --project-dir PATH");
      const identity = resolveProjectIdentity({
        projectDir: resolve(flags.project_dir),
        explicitProject: flags.project,
      });
      output({ project: identity, ...registerProject(home, identity, { apply: Boolean(flags.apply) }) });
    } else throw new Error(`unknown projects action: ${action}`);
  } else if (command === "opencode") {
    const action = positional.shift() || "status";
    const configDir = flags.opencode_config_dir ? resolve(flags.opencode_config_dir) : undefined;
    if (action === "install") {
      const binary = isStandaloneBinary() ? process.execPath : resolve(process.argv[1]);
      output(installGlobalOpenCode({
        configDir,
        workspaceRoots: listFlag(flags.workspace_root),
        home,
        binary,
        apply: Boolean(flags.apply),
      }));
    } else if (action === "ensure") {
      if (!flags.project_dir) throw new Error("opencode ensure requires --project-dir PATH");
      output(ensureTrustedProject(home, {
        directory: resolve(flags.project_dir),
        worktree: flags.worktree ? resolve(flags.worktree) : null,
        workspaceRoots: listFlag(flags.workspace_root),
        apply: Boolean(flags.apply),
      }));
    } else if (action === "status") {
      output(globalOpenCodeStatus({ configDir }));
    } else if (action === "uninstall") {
      output(uninstallGlobalOpenCode({ configDir, apply: Boolean(flags.apply) }));
    } else throw new Error(`unknown opencode action: ${action}`);
  } else if (command === "agents") {
    const action = positional.shift() || "status";
    if (action === "detect") output({ agents: detectAgents() });
    else if (action === "status") {
      const detectedAgents = detectAgents();
      output({ agents: connectionStatus(agentOptions()).map((item) => {
        const found = detectedAgents.find((candidate) => candidate.client === item.client);
        return { ...item, detected: Boolean(found?.installed), detected_executable: found?.executable || null };
      }) });
    }
    else if (action === "connect" || action === "disconnect") {
      const selected = agentSelection(positional.shift() || flags.agents || "detected");
      const operation = action === "connect" ? connectAgents : disconnectAgents;
      const detectedAgents = detectAgents();
      if (action === "connect") {
        const projectDir = resolve(flags.project_dir || process.cwd());
        const identity = resolveProjectIdentity({ projectDir, explicitProject: flags.project });
        const registered = listRegisteredProjects(home).find((project) => project.id === identity.id);
        if (!registered) throw new Error(`project ${identity.id} is not registered; run continuitydb projects add first`);
        if (resolve(registered.root) !== resolve(identity.root)) {
          throw new Error(`project ${identity.id} is registered at ${registered.root}, not ${identity.root}`);
        }
      }
      output({
        action,
        applied: Boolean(flags.apply),
        results: withDetection(operation(selected, agentOptions()), detectedAgents),
      });
    } else throw new Error(`unknown agents action: ${action}`);
  } else if (command === "hook") {
    const { runLifecycleHook } = await import("./lifecycle-hook.js");
    process.exitCode = await runLifecycleHook(rawArguments.slice(1));
  } else if (command === "init") {
    const releaseInitializationLock = acquireVaultInitializationLock(home);
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const configPath = join(home, "config.json");
      if (!existsSync(configPath)) {
        writeFileSync(configPath, `${JSON.stringify({
          schema_version: 1,
          mode: "local",
          tenant_id: "local",
          created_at: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o600 });
      }
      const vault = new ContextVault(home);
      const stats = vault.stats();
      vault.close();
      output({ initialized: true, home, config: configPath, stats });
    } finally {
      releaseInitializationLock();
    }
  } else if (command === "doctor") {
    const checks = [];
    checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.version });
    checks.push({ name: "home", ok: existsSync(home), value: home });
    if (existsSync(home)) {
      const mode = statSync(home).mode;
      checks.push({
        name: "home_permissions",
        ok: hasPrivateDirectoryPermissions(mode),
        value: process.platform === "win32" ? "managed by Windows ACL" : (mode & 0o777).toString(8),
      });
    }
    try {
      const vault = new ContextVault(home);
      const audit = vault.verifyAuditLog();
      checks.push({ name: "sqlite", ok: true, value: "WAL + FTS5" });
      checks.push({ name: "audit_chain", ok: audit.valid, value: audit });
      if (process.env.CONTINUITYDB_EMBEDDING_PROVIDER === "local") {
        const model = localModelStatus({ home, cacheDir: process.env.CONTINUITYDB_MODEL_CACHE });
        checks.push({ name: "local_embedding_model", ok: model.ready, value: model });
      }
      vault.close();
    } catch (error) {
      checks.push({ name: "storage", ok: false, value: error.message });
    }
    output({ ok: checks.every((check) => check.ok), checks });
    if (!checks.every((check) => check.ok)) process.exitCode = 1;
  } else if (command === "serve" || command === "run" || command === "start") {
    process.env.CONTINUITYDB_HOME = home;
    if (flags.review_ui) process.env.CONTINUITYDB_ENABLE_REVIEW_UI = "true";
    const service = createContinuityServer({
      host: flags.host || process.env.CONTINUITYDB_HOST || "127.0.0.1",
      port: numberFlag(flags.port, Number(process.env.CONTINUITYDB_PORT || 7331)),
      enableReviewUi: Boolean(flags.review_ui) || process.env.CONTINUITYDB_ENABLE_REVIEW_UI === "true",
    });
    const address = await service.listen();
    process.stderr.write(`ContinuityDB ready at ${typeof address === "string" ? address : `${address.address}:${address.port}`}\n`);
    const shutdown = async () => { await service.close(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else if (command === "mcp") {
    process.env.CONTINUITYDB_HOME = home;
    process.env.CONTEXT_VAULT_HOME = home;
    const { runStdioMcp } = await import("./mcp-server.js");
    const runtime = await runStdioMcp();
    const shutdown = async () => {
      await runtime.server.close().catch(() => {});
      runtime.vault?.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else if (command === "graph" && positional[0] === "build" && !flags.apply) {
    if (!flags.repo) throw new Error("graph build requires --repo PATH");
    if (!flags.project) throw new Error("graph build requires --project ID");
    const previewRoot = mkdtempSync(join(tmpdir(), "continuitydb-graph-preview-"));
    const previewVault = new ContextVault(previewRoot);
    try {
      output({
        ...buildRepositoryGraph(previewVault, resolve(flags.repo), {
          projectId: flags.project,
          tenantId: cliTenantId,
        }),
        preview: true,
        applied: false,
      });
    } finally {
      previewVault.close();
      rmSync(previewRoot, { recursive: true, force: true });
    }
  } else {
    const vault = new ContextVault(home);
    const embedder = createEmbedderFromEnv({
      ...process.env,
      CONTINUITYDB_HOME: home,
      CONTEXT_VAULT_HOME: home,
    });
    const engine = new HybridEngine(vault, embedder);
    try {
      if (command === "graph") {
        const action = positional.shift();
        if (!flags.project) throw new Error(`graph ${action || "command"} requires --project ID`);
        const scope = {
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          project_id: flags.project,
          ...(flags.branch ? { branch: flags.branch } : {}),
          allowed_projects: [flags.project],
          allowed_sensitivities: listFlag(flags.sensitivities || "public,private"),
          graph_depth: numberFlag(flags.depth, 2),
          graph_max_visited: numberFlag(flags.graph_max_visited ?? flags.max_visited, 400),
          graph_max_paths: numberFlag(flags.graph_max_paths ?? flags.max_paths, 40),
          strict_evidence: Boolean(flags.strict_evidence),
        };
        // Reuse the external request validator for graph traversal budgets.
        normalizeSearchRequest({ query: flags.node || flags.from || flags.project, ...scope });
        if (action === "build") {
          if (!flags.repo) throw new Error("graph build requires --repo PATH");
          output({
            ...buildRepositoryGraph(vault, resolve(flags.repo), {
              projectId: flags.project,
              tenantId: cliTenantId,
            }),
            preview: false,
            applied: true,
          });
        } else if (action === "status") {
          output(vault.graphStatus(scope));
        } else if (action === "explain") {
          if (!flags.node) throw new Error("graph explain requires --node QUALIFIED_NAME");
          output(vault.explainGraphNode({ ...scope, node: flags.node }));
        } else if (action === "path") {
          if (!flags.from || !flags.to) throw new Error("graph path requires --from and --to");
          output(vault.findGraphPath({ ...scope, from: flags.from, to: flags.to }));
        } else throw new Error(`unknown graph action: ${action}`);
      } else if (command === "propose") {
        output(vault.propose({
          body: flags.body,
          title: flags.title,
          project_id: flags.project || null,
          namespace_id: flags.project ? `project/${flags.project}` : "personal/global",
          type: flags.type,
          sensitivity: flags.sensitivity,
          source_uri: flags.source_uri,
          repo_path: flags.repo_path,
          symbol: flags.symbol,
          git_commit: flags.git_commit,
          branch: flags.branch,
          tags: listFlag(flags.tags),
          idempotency_key: flags.idempotency_key,
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          agent_id: cliAgentId,
        }));
      } else if (command === "capture") {
        const principalId = process.env.CONTINUITYDB_PRINCIPAL_ID || "local-agent";
        const ownerId = process.env.CONTINUITYDB_OWNER_ID || "local-user";
        const agentId = process.env.CONTINUITYDB_AGENT_ID || principalId;
        const projectId = flags.project;
        const identity = normalizeIdentity({
          tenant_id: process.env.CONTINUITYDB_TENANT_ID || "local",
          principal_id: principalId,
          owner_id: ownerId,
          agent_id: agentId,
          scopes: ["memory:capture"],
          allowed_projects: listFlag(process.env.CONTINUITYDB_ALLOWED_PROJECTS || projectId),
          allowed_sensitivities: listFlag(process.env.CONTINUITYDB_ALLOWED_SENSITIVITIES || "public,private"),
        });
        const policy = new CapturePolicy(loadCapturePolicy(flags.policy || process.env.CONTINUITYDB_CAPTURE_POLICY_FILE || null));
        const assessment = policy.evaluate({
          body: flags.body,
          title: flags.title,
          project_id: projectId,
          memory_kind: flags.kind || "inference",
          confidence: flags.confidence === undefined ? undefined : numberFlag(flags.confidence),
          importance: flags.importance === undefined ? undefined : numberFlag(flags.importance),
          sensitivity: flags.sensitivity,
          ttl_seconds: flags.ttl_seconds === undefined ? undefined : numberFlag(flags.ttl_seconds),
          subject_key: flags.subject_key,
          repo_path: flags.repo_path,
          symbol: flags.symbol,
          git_commit: flags.git_commit,
          branch: flags.branch,
          content_checksum: flags.content_checksum,
          tags: listFlag(flags.tags),
          idempotency_key: flags.idempotency_key,
        }, identity, vault);
        const captured = vault.capture(assessment, { actor: `${identity.principal_id}/${identity.agent_id}` });
        let semantic_index = { indexed: false, reason: "memory is not active or semantic retrieval is disabled" };
        if (captured.record.status === "active" && embedder) {
          try { semantic_index = await engine.indexMemory(captured.record.id); }
          catch (error) { semantic_index = { indexed: false, reason: error.message }; }
        }
        output({ ...captured, semantic_index });
      } else if (command === "commit") {
        const committed = vault.approve(positional[0], { actor: "cli-reviewer" });
        let semantic_index = { indexed: false, reason: "semantic retrieval disabled" };
        if (embedder) {
          try { semantic_index = await engine.indexMemory(committed.id); }
          catch (error) { semantic_index = { indexed: false, reason: error.message }; }
        }
        output({ ...committed, semantic_index });
      } else if (command === "correct") {
        const replacement = Object.fromEntries(Object.entries({
          body: flags.body,
          title: flags.title,
          confidence: flags.confidence === undefined ? undefined : numberFlag(flags.confidence),
          importance: flags.importance === undefined ? undefined : numberFlag(flags.importance),
          tags: flags.tags === undefined ? undefined : listFlag(flags.tags),
          handoff: flags.handoff_file === undefined
            ? undefined
            : JSON.parse(readFileSync(resolve(flags.handoff_file), "utf8")),
        }).filter(([, value]) => value !== undefined));
        output(vault.correct(positional[0], replacement, flags.reason || "cli-correction"));
      } else if (command === "search") {
        const allowed_projects = listFlag(flags.allow_projects || flags.project);
        const request = normalizeSearchRequest({
          query: flags.query === true ? "" : (flags.query || positional.join(" ")),
          project_id: flags.project || null,
          dependency_depth: numberFlag(flags.dependency_depth ?? flags.depth, 2),
          top_k: numberFlag(flags.top_k, 8),
          token_budget: numberFlag(flags.token_budget, 1200),
          branch: flags.branch || null,
          as_of: flags.as_of || null,
          include_stale: Boolean(flags.include_stale),
          retrieval_mode: flags.mode || flags.retrieval_mode || "hybrid",
          graph_depth: numberFlag(flags.depth, 2),
          strict_evidence: Boolean(flags.strict_evidence),
          graph_max_visited: numberFlag(flags.graph_max_visited ?? flags.max_visited, 400),
          graph_max_paths: numberFlag(flags.graph_max_paths ?? flags.max_paths, 40),
        }, {
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          allowed_projects,
          allowed_sensitivities: listFlag(flags.sensitivities || "public,private"),
        });
        output(await engine.searchDetailed(request));
      } else if (command === "context") {
        output(await engine.contextPack({
          task: positional.join(" "),
          project_id: flags.project || null,
          allowed_projects: listFlag(flags.allow_projects || flags.project),
          allowed_sensitivities: listFlag(flags.sensitivities || "public,private"),
          dependency_depth: numberFlag(flags.depth, 2),
          top_k: numberFlag(flags.top_k, 8),
          token_budget: numberFlag(flags.token_budget, 1200),
          branch: flags.branch || null,
          as_of: flags.as_of || null,
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
        }));
      } else if (command === "handoff-save") {
        if (!flags.file) throw new Error("handoff-save requires --file");
        const checkpoint = JSON.parse(readFileSync(resolve(flags.file), "utf8"));
        const identity = normalizeIdentity({
          tenant_id: cliTenantId,
          principal_id: cliPrincipalId,
          owner_id: cliOwnerId,
          agent_id: cliAgentId || cliPrincipalId,
          scopes: ["memory:capture"],
          allowed_projects: listFlag(process.env.CONTINUITYDB_ALLOWED_PROJECTS || checkpoint.project_id),
          allowed_sensitivities: listFlag(process.env.CONTINUITYDB_ALLOWED_SENSITIVITIES || "public,private"),
        });
        const handoffInput = {
          ...checkpoint,
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          principal_id: cliPrincipalId,
          agent_id: cliAgentId,
        };
        const policy = new CapturePolicy(loadCapturePolicy(flags.policy || process.env.CONTINUITYDB_CAPTURE_POLICY_FILE || null));
        output(vault.saveHandoff(handoffInput, {
          assessment: policy.evaluateHandoff(handoffInput, identity, vault),
          actor: `${identity.principal_id}/${identity.agent_id}`,
        }));
      } else if (command === "handoff-latest") {
        output(vault.latestHandoff({
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          project_id: flags.project,
          task_id: positional[0],
          branch: flags.branch || null,
          allowed_sensitivities: listFlag(flags.sensitivities || "public,private"),
        }));
      } else if (command === "link-project") {
        output(vault.linkProjects({
          source_project: positional[0],
          target_project: positional[1],
          relation: flags.relation || "depends-on",
          weight: numberFlag(flags.weight, 1),
          provenance: flags.provenance,
          tenant_id: cliTenantId,
        }));
      } else if (command === "link-memory") {
        output(vault.linkMemories({
          source_memory_id: positional[0],
          target_memory_id: positional[1],
          relation: flags.relation,
          weight: numberFlag(flags.weight, 1),
          provenance: flags.provenance,
          tenant_id: cliTenantId,
        }));
      } else if (command === "forget") {
        output(vault.forget(positional[0], flags.reason || "cli-request"));
      } else if (command === "feedback") {
        const principalId = process.env.CONTINUITYDB_PRINCIPAL_ID || "local-user";
        output(vault.feedback({
          tenant_id: process.env.CONTINUITYDB_TENANT_ID || "local",
          owner_id: process.env.CONTINUITYDB_OWNER_ID || principalId,
          principal_id: principalId,
          agent_id: process.env.CONTINUITYDB_AGENT_ID || null,
          memory_id: positional[0],
          signal: flags.signal,
          reason: flags.reason || null,
        }));
      } else if (command === "stats") {
        output(vault.stats({ tenant_id: cliTenantId }));
      } else if (command === "export") {
        const data = vault.exportJsonl();
        if (flags.output) {
          const destination = resolve(flags.output);
          writeFileSync(destination, data ? `${data}\n` : "", { mode: 0o600, flag: "wx" });
          output({ exported: data ? data.split("\n").length : 0, output: destination });
        } else process.stdout.write(data ? `${data}\n` : "");
      } else if (command === "audit-verify") {
        const result = vault.verifyAuditLog();
        output(result);
        if (!result.valid) process.exitCode = 1;
      } else if (command === "repo-scan") {
        const result = scanRepository(positional[0], {
          projectId: flags.project,
          since: flags.since,
          maxFiles: numberFlag(flags.max_files, 20_000),
          maxFileBytes: numberFlag(flags.max_file_bytes, 1_000_000),
          includeDocs: !flags.no_docs,
        });
        let ingested = [];
        if (flags.ingest) ingested = vault.ingestBatch(result.records.map((record) => ({
          ...record,
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          agent_id: cliAgentId,
        })), { commit: Boolean(flags.commit) });
        output({ ...result, records: flags.include_records ? result.records : undefined, ingested: ingested.length, committed: Boolean(flags.commit) });
      } else if (command === "embeddings-status") {
        output(localModelStatus({ home, cacheDir: flags.cache || process.env.CONTINUITYDB_MODEL_CACHE }));
      } else if (command === "embeddings-pull") {
        output(await ensureLocalModel({ home, cacheDir: flags.cache || process.env.CONTINUITYDB_MODEL_CACHE }));
      } else if (command === "embeddings-index") {
        if (!embedder) throw new Error("configure CONTINUITYDB_EMBEDDING_PROVIDER=local or another supported provider");
        output(await engine.indexPending({
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          limit: numberFlag(flags.limit, 10_000),
          batch_size: numberFlag(flags.batch_size, 32),
        }));
      } else {
        throw new Error(`unknown command: ${command}`);
      }
    } finally {
      vault.close();
    }
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, command })}\n`);
  process.exitCode = 1;
}
