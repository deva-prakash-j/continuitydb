#!/usr/bin/env node
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
import { basename, dirname, join, resolve } from "node:path";
import { ContextVault } from "./store.js";
import { createContinuityServer } from "./http-server.js";
import { scanRepository } from "./repo-ingest.js";
import { CapturePolicy, loadCapturePolicy } from "./capture-policy.js";
import { normalizeIdentity } from "./security.js";
import { createEmbedderFromEnv, HybridEngine } from "./embeddings.js";
import { ensureLocalModel, localModelStatus } from "./local-embeddings.js";
import {
  connectAgents,
  connectionStatus,
  detectAgents,
  disconnectAgents,
  SUPPORTED_AGENTS,
} from "./agent-connectors.js";
import { isStandaloneBinary } from "./binary-runtime.js";
import { installStandaloneBinary } from "./self-install.js";
import { VERSION } from "./version.js";
import { defaultDataHome } from "./paths.js";

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inline !== undefined) flags[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
    else flags[key] = true;
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
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function output(value, pretty = true) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function usage() {
  process.stdout.write(`ContinuityDB — portable context graph for AI agents

Usage:
  continuitydb version
  continuitydb install [--prefix PATH] --apply
  continuitydb setup [--agents detected|all|A,B] [--project-dir PATH] [--apply]
  continuitydb init [--home PATH]
  continuitydb doctor [--home PATH]
  continuitydb run [--home PATH] [--host HOST] [--port PORT] [--review-ui]
  continuitydb agents detect
  continuitydb agents status [--project-dir PATH]
  continuitydb agents connect AGENT|all [--project-dir PATH] [--transport stdio|http] [--url URL] --apply
  continuitydb agents disconnect AGENT|all [--project-dir PATH] --apply
  continuitydb mcp [--home PATH]
  continuitydb hook session-start|checkpoint [HOOK OPTIONS]
  continuitydb propose --body TEXT [--project ID] [--title TEXT] [--idempotency-key KEY]
  continuitydb capture --body TEXT --project ID [--kind working|inference|git-fact|decision]
  continuitydb commit MEMORY_ID
  continuitydb correct MEMORY_ID [--body TEXT | --handoff-file HANDOFF.json] [--reason TEXT]
  continuitydb search QUERY [--project ID] [--allow-projects A,B] [--top-k N]
  continuitydb context TASK [--project ID] [--allow-projects A,B] [--token-budget N]
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

function agentSelection(value) {
  const requested = listFlag(value || "detected");
  if (requested.includes("all")) return [...SUPPORTED_AGENTS];
  if (requested.includes("detected")) return detectAgents().filter((item) => item.installed).map((item) => item.client);
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
    projects: listFlag(flags.projects || flags.project),
    sensitivities: listFlag(flags.sensitivities || "public,private"),
    transport: flags.transport || "stdio",
    url: flags.url,
    tokenEnv: flags.token_env,
    apply: Boolean(flags.apply),
  };
}

function assertSetupHome(path) {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`setup home must be a real directory, not a symlink: ${path}`);
  }
}

function removeCreatedSetupArtifacts(home, before) {
  const paths = ["config.json", "records", "index", "models"];
  for (const name of paths.reverse()) {
    const path = join(home, name);
    if (!before.has(name) && existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

async function initializeSetupHome(home, flags) {
  assertSetupHome(home);
  const existed = existsSync(home);
  const configuredCache = flags.cache || process.env.CONTINUITYDB_MODEL_CACHE;
  let target = home;
  let staging = null;
  let before = new Set();

  if (existed) {
    before = new Set(["config.json", "records", "index", "models"].filter((name) => existsSync(join(home, name))));
  } else {
    mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(dirname(home), `.${basename(home)}.setup-`));
    chmodSync(staging, 0o700);
    target = staging;
  }

  try {
    const configPath = join(target, "config.json");
    if (!existsSync(configPath)) {
      writeFileSync(configPath, `${JSON.stringify({
        schema_version: 2,
        mode: "local",
        tenant_id: flags.tenant || cliTenantId,
        owner_id: flags.owner || cliOwnerId,
        created_at: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
    }
    const vault = new ContextVault(target);
    const stats = vault.stats();
    vault.close();
    let embeddings = null;
    if (flags.semantic) {
      embeddings = await ensureLocalModel({ home: target, cacheDir: configuredCache });
    }
    if (staging) {
      if (existsSync(home)) throw new Error(`setup home appeared while initialization was in progress: ${home}`);
      renameSync(staging, home);
      staging = null;
      if (flags.semantic && !configuredCache) embeddings = localModelStatus({ home });
    }
    return { stats, embeddings, created: !existed, before };
  } catch (error) {
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (existed) removeCreatedSetupArtifacts(home, before);
    throw error;
  }
}

try {
  if (command === "version") {
    output({ version: VERSION, standalone: isStandaloneBinary(), node: process.version, platform: process.platform, arch: process.arch });
  } else if (command === "install") {
    output(installStandaloneBinary({ prefix: flags.prefix, apply: Boolean(flags.apply), force: Boolean(flags.force) }));
  } else if (command === "setup") {
    const selected = agentSelection(flags.agents);
    const connectionOptions = agentOptions();
    // Setup must fail without touching the global vault when any client
    // configuration cannot be parsed or safely rendered.
    const previewConnections = connectAgents(selected, { ...connectionOptions, apply: false });
    const configPath = join(home, "config.json");
    if (!connectionOptions.apply) {
      output({
        setup: true,
        preview: true,
        home,
        config: configPath,
        stats: null,
        detected_agents: detectAgents(),
        connections: previewConnections,
        embeddings: flags.semantic ? { planned: true, provider: "local" } : null,
        applied: false,
        run: { command: isStandaloneBinary() ? process.execPath : "continuitydb", args: ["run", "--home", home] },
      });
      process.exit(0);
    }

    const initialized = await initializeSetupHome(home, flags);
    let connections;
    try {
      // This is intentionally the final fallible setup mutation. The connector
      // layer rolls its whole batch back. If this invocation created the vault,
      // remove it as well so setup remains end-to-end atomic.
      connections = connectAgents(selected, connectionOptions);
    } catch (error) {
      if (initialized.created && existsSync(home)) rmSync(home, { recursive: true, force: true });
      else removeCreatedSetupArtifacts(home, initialized.before);
      throw error;
    }
    output({
      setup: true,
      home,
      config: configPath,
      stats: initialized.stats,
      detected_agents: detectAgents(),
      connections,
      embeddings: initialized.embeddings,
      applied: Boolean(flags.apply),
      run: { command: isStandaloneBinary() ? process.execPath : "continuitydb", args: ["run", "--home", home] },
    });
  } else if (command === "agents") {
    const action = positional.shift() || "status";
    if (action === "detect") output({ agents: detectAgents() });
    else if (action === "status") output({ agents: connectionStatus(agentOptions()) });
    else if (action === "connect" || action === "disconnect") {
      const selected = agentSelection(positional.shift() || flags.agents || "detected");
      const operation = action === "connect" ? connectAgents : disconnectAgents;
      output({ action, applied: Boolean(flags.apply), results: operation(selected, agentOptions()) });
    } else throw new Error(`unknown agents action: ${action}`);
  } else if (command === "hook") {
    const { runLifecycleHook } = await import("./lifecycle-hook.js");
    process.exitCode = await runLifecycleHook(rawArguments.slice(1));
  } else if (command === "init") {
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
  } else if (command === "doctor") {
    const checks = [];
    checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.version });
    checks.push({ name: "home", ok: existsSync(home), value: home });
    if (existsSync(home)) checks.push({ name: "home_permissions", ok: (statSync(home).mode & 0o077) === 0, value: (statSync(home).mode & 0o777).toString(8) });
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
  } else {
    const vault = new ContextVault(home);
    const embedder = createEmbedderFromEnv({
      ...process.env,
      CONTINUITYDB_HOME: home,
      CONTEXT_VAULT_HOME: home,
    });
    const engine = new HybridEngine(vault, embedder);
    try {
      if (command === "propose") {
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
        output({ results: await engine.search({
          query: positional.join(" "),
          project_id: flags.project || null,
          allowed_projects: listFlag(flags.allow_projects || flags.project),
          allowed_sensitivities: listFlag(flags.sensitivities || "public,private"),
          dependency_depth: numberFlag(flags.depth, 2),
          top_k: numberFlag(flags.top_k, 8),
          token_budget: numberFlag(flags.token_budget, 1200),
          branch: flags.branch || null,
          as_of: flags.as_of || null,
          include_stale: Boolean(flags.include_stale),
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
        }) });
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
