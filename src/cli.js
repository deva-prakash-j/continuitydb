#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContextVault } from "./store.js";
import { createContinuityServer } from "./http-server.js";
import { scanRepository } from "./repo-ingest.js";
import { CapturePolicy, loadCapturePolicy } from "./capture-policy.js";
import { normalizeIdentity } from "./security.js";
import { createEmbedderFromEnv, HybridEngine } from "./embeddings.js";
import { ensureLocalModel, localModelStatus } from "./local-embeddings.js";

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
  continuitydb init [--home PATH]
  continuitydb doctor [--home PATH]
  continuitydb serve [--home PATH] [--host HOST] [--port PORT] [--review-ui]
  continuitydb mcp [--home PATH]
  continuitydb propose --body TEXT [--project ID] [--title TEXT] [--idempotency-key KEY]
  continuitydb capture --body TEXT --project ID [--kind working|inference|git-fact|decision]
  continuitydb commit MEMORY_ID
  continuitydb correct MEMORY_ID --body TEXT [--reason TEXT]
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

const { positional, flags } = parse(process.argv.slice(2));
const command = positional.shift();
const home = resolve(flags.home || process.env.CONTINUITYDB_HOME || process.env.CONTEXT_VAULT_HOME || join(process.cwd(), ".continuitydb"));
const cliTenantId = process.env.CONTINUITYDB_TENANT_ID || "local";
const cliPrincipalId = process.env.CONTINUITYDB_PRINCIPAL_ID || "local-user";
const cliOwnerId = process.env.CONTINUITYDB_OWNER_ID || cliPrincipalId;
const cliAgentId = process.env.CONTINUITYDB_AGENT_ID || null;

if (!command || command === "help" || flags.help) {
  usage();
  process.exit(0);
}

try {
  if (command === "init") {
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
  } else if (command === "serve") {
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
    await import("./mcp-server.js");
  } else {
    const vault = new ContextVault(home);
    const embedder = createEmbedderFromEnv();
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
        const committed = vault.commit(positional[0]);
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
        output(vault.saveHandoff({
          ...checkpoint,
          tenant_id: cliTenantId,
          owner_id: cliOwnerId,
          principal_id: cliPrincipalId,
          agent_id: cliAgentId,
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
