# ContinuityDB

[![CI](https://github.com/deva-prakash-j/continuitydb/actions/workflows/ci.yml/badge.svg)](https://github.com/deva-prakash-j/continuitydb/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 22.5+](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#project-status)

**Portable, Git-grounded context continuity for AI agents.**

ContinuityDB lets useful engineering context survive a new chat, repository,
IDE, coding agent, or model provider. Agents retrieve a small, cited context
pack from lexical, semantic, and dependency-graph signals while tenant, owner,
project, sensitivity, and temporal boundaries are enforced before content is
returned.

## Project status

> **Project status:** v0.7 alpha candidate. The embedded SQLite/FTS5 mode is implemented,
> tested, and suitable for local evaluation. The repository includes a
> PostgreSQL/pgvector reference schema and distributed architecture, but the
> production adapter and billion-record proof do not exist yet. Remote MCP and
> client adapters are evidence-graded: a tested configuration is not described
> as a real-client tool-call proof unless that exact client performed the call.

### Verification status

The v0.7 release candidate at `8c0fa54c8d4981de458f6cdb498a358a5a0faa3b`
has passed its builder and supported-native CI gates:

- full automated suite: **125/125 passing**, with 0 failed and 0 skipped;
- OpenAPI validation: **20 paths**;
- exact lexical Recall@5: **9/9**, with **0 isolation violations**;
- dependency audit: **0 known production vulnerabilities**;
- package dry-run: **86 files**;
- Linux x64, macOS arm64, and Windows x64 standalone executables: native
  functional smoke, local semantic inference, checksum, and artifact upload
  **terminal green**;
- Node 22/24, container, and Linux binary CI: **terminal green**.

The candidate serializes ContinuityDB-controlled setup, first-open, connector,
model-cache, and installer operations with crash-released SQLite transaction
locks plus compare-and-swap rollback. Direct edits made by programs that do not
participate in the lock protocol are rechecked immediately before replacement,
but do not receive a portable cross-process transaction guarantee.

See the exact commands, GitHub run URLs, artifact digests, environment, and
evidence boundaries in the
[v0.7 verification record](docs/build-verification-2026-09-11-v0.7.md).
The independent Astraea verdict remains the final release gate. Intel macOS
uses the npm distribution because upstream Node 25 SEA executables
[segfault on x64 macOS](https://github.com/nodejs/node/issues/62893).

## The problem

Coding agents usually understand the open repository and current conversation.
They often lose context that lives elsewhere:

- an API contract decision made in another repository;
- a release order agreed in a previous session;
- the downstream effect of a schema or event change;
- a correction learned by a different agent or IDE;
- the commit, path, and symbol that make a recalled fact verifiable.

Repository-local instructions help inside one codebase. Conversation memory
helps inside one provider. ContinuityDB is an independent evidence layer that
can be shared by authorized agents without making the model provider the source
of truth.

```text
Copilot / Codex / Claude / Cursor / Gemini / OpenClaw / custom agents
                                  |
                             MCP or HTTP
                                  |
                    server-owned identity and policy
                                  |
              lexical + semantic + dependency graph retrieval
                                  |
                    small, cited, token-bounded context pack
                                  |
          canonical records + rebuildable search/vector/graph indexes
```

## What ContinuityDB is—and is not

| ContinuityDB is | ContinuityDB is not |
|---|---|
| A provider-neutral memory and context service for agents | A replacement for an LLM or coding agent |
| A Git-aware evidence store with citations and validity | A raw transcript archive |
| A policy-controlled automatic capture system | Permission for agents to approve or delete their own memory |
| A local-first embedded runtime with a distributed contract | A billion-scale database proven by a laptop benchmark |
| A source of untrusted evidence for agent reasoning | An authorization or prompt-policy channel |

## Core use cases

### Cross-session continuity

An agent captures a project-scoped implementation constraint. A later session
recalls it without copying the old conversation.

### Cross-repository dependency work

Link an API repository to its schema or event producer. Queries from the API
project can retrieve explicitly allowed dependency context with source citations.

### Cross-agent and cross-provider handoff

Multiple authenticated agents use different `principal_id` and `agent_id`
values while sharing the same stable `owner_id`. This preserves attribution
without fragmenting the owner's memory.

### Governed organizational memory

Tenant, project, sensitivity, lifecycle, temporal, and provenance controls keep
retrieval bounded. Personal and employer data should still use separate stores
and credentials when their trust domains differ.

## Current main capabilities

### Retrieval

- SQLite WAL and FTS5/BM25 lexical retrieval for identifiers, paths, errors, and keywords;
- built-in local BGE-small quantized embeddings plus optional Ollama or OpenAI-compatible providers;
- bounded exact vector scan for embedded mode;
- project dependency closure and typed memory-graph expansion;
- Reciprocal Rank Fusion across lexical, semantic, and graph candidates;
- project proximity, confidence, importance, freshness, exact-score, and bounded feedback signals;
- Maximal Marginal Relevance to reduce duplicate context;
- branch, validity-time, expiry, stale-state, and token-budget controls;
- repo/path/symbol/commit/branch citations in every returned memory.

### Memory lifecycle

- proposed, active, quarantined, superseded, and tombstoned statuses plus TTL expiry;
- risk-based automatic agent capture;
- explicit proposal and separate approval flow;
- correction by supersession rather than silent overwrite;
- per-principal helpful/incorrect/outdated feedback;
- tenant/owner/namespace/agent-scoped idempotency keys;
- canonical human-readable records and rebuildable indexes;
- JSONL export and index rebuild support;
- structured, task-addressable handoff checkpoints with branch-aware latest retrieval;
- SHA-256 hash-chained audit events serialized transactionally in SQLite.

### Interfaces and operations

- standalone Linux, macOS, and Windows binary build pipeline with the Node
  runtime and local ONNX/WASM inference runtime included;
- idempotent user-scoped self-install plus CLI-managed project connections for
  Codex, Claude Code, OpenCode, Cursor, and VS Code Copilot;
- six scope-filtered agent-facing MCP tools, including structured handoff save/retrieval;
- stateful Streamable HTTP MCP at `/mcp`, plus local stdio and HTTP-backed thin-stdio modes;
- explicit MCP safety annotations, server instructions, bearer/OIDC identity binding,
  session expiry/capacity controls, and cross-credential session-hijack rejection;
- versioned Codex, Copilot, Claude Code, OpenCode, Cursor, and generic MCP examples;
- lifecycle hook adapters for Claude Code, Cursor, and OpenCode without transcript mining;
- opt-in local review inbox for approval, correction, provenance inspection, and context preview;
- versioned HTTP API with server-bound identity and scoped authorization;
- CLI for setup, health checks, capture, lifecycle, retrieval, graph links,
  repository scanning, export, statistics, and audit verification;
- Git committed-blob scanner with incremental mode, symlink rejection, file
  limits, and a secret-path denylist; dirty worktree content is never attributed to `HEAD`;
- OpenAPI contract, tests, benchmarks, CI, non-root container, threat model,
  security policy, contribution guide, and governance document;
- 64-partition PostgreSQL/pgvector reference migrations with owner-aware row-level security.

### Reliability and concurrency

- fresh-vault WAL transition, schema creation, and additive migrations are
  serialized so concurrent first-open processes wait instead of racing bootstrap;
- handoff idempotency is scoped by tenant, owner, agent, project, task, and branch;
- handoff lineage, quota evaluation, sequence allocation, persistence, and
  supersession execute in one `BEGIN IMMEDIATE` transaction;
- stale or concurrent successors are quarantined instead of replacing the
  current startup checkpoint;
- a quota slot is reused only when an agent supersedes its own checkpoint;
  cross-agent succession consumes the receiving agent's quota;
- review approval revalidates lineage and quota in the write transaction, so
  only one concurrent reviewer can activate a successor;
- legacy audit events retain their original hashes; corrupted or divergent
  history is reported invalid rather than rewritten into a valid-looking chain.

See the [architecture](docs/architecture.md) and
[competitor-derived capability review](docs/competitive-research-2026-09-09.md)
for design details and deliberate exclusions.

## Standalone binary quick start

The standalone executable does not require system Node.js or npm. Release
automation builds native artifacts for Linux x64, macOS arm64, and Windows x64.
Intel macOS is not published because upstream Node 25 SEA executables
[segfault on x64 macOS](https://github.com/nodejs/node/issues/62893). Every
supported artifact receives a SHA-256 sidecar and GitHub build-provenance
attestation. Every successful push to `main` creates a commit-bound prerelease
with all supported native binaries; workflow reruns update the same release
idempotently. Pushed `v*` tags create stable releases. Intel macOS remains
npm-only until upstream Node SEA support is available.

After downloading the artifact for your platform, verify its `.sha256` sidecar,
then preview and apply a user-scoped installation:

```bash
chmod +x ./continuitydb-linux-x64
./continuitydb-linux-x64 install
./continuitydb-linux-x64 install --apply

export PATH="$HOME/.local/bin:$PATH"
continuitydb version
```

`install` writes a versioned executable below `~/.local/lib/continuitydb` and
atomically updates `~/.local/bin/continuitydb`. It does not edit shell profiles
or replace an unmanaged launcher unless `--force` is explicit. Windows defaults
to `%LOCALAPPDATA%\\ContinuityDB`.

From a repository, initialize a private vault and connect every installed
supported client. Both commands initialize the private vault; the first only
previews client-config changes, while the second creates backups and applies
them:

```bash
continuitydb setup --agents detected --project-dir "$PWD"
continuitydb setup --agents detected --project-dir "$PWD" --apply

# Or generate all five supported project configurations:
continuitydb setup --agents all --project-dir "$PWD" --apply

continuitydb agents status --project-dir "$PWD"
continuitydb run
```

By default every project points at the same platform user-data vault:
`~/.local/share/continuitydb` on Linux, `~/Library/Application Support/ContinuityDB`
on macOS, and `%LOCALAPPDATA%\\ContinuityDB\\data` on Windows. `--home` remains
an explicit override. Add `--semantic` to `setup` to download and verify the pinned 34.2 MB local
embedding model. The binary already contains the integrity-pinned ONNX/WASM
runtime, so no separate inference package is installed.

The generated project files are:

| Client | Managed project file |
|---|---|
| Codex | `.codex/config.toml` managed block |
| Claude Code | `.mcp.json` → `mcpServers.continuitydb` |
| OpenCode | `opencode.json` → `mcp.continuitydb` |
| Cursor | `.cursor/mcp.json` → `mcpServers.continuitydb` |
| VS Code Copilot | `.vscode/mcp.json` → `servers.continuitydb` |

Single-client writes are atomic. Multi-client `setup` and `agents connect`
operations use a two-phase batch: every selected JSON/TOML file, managed
namespace, marker, path, and rendered output is validated before the first
client file changes. If a later filesystem write still fails, earlier client
changes and newly created config directories are rolled back. Symlinked config
paths are rejected, existing files are backed up privately below the vault, and
rerunning setup is idempotent. Static secrets are never written: remote configs
store only a token environment variable reference. Disconnect removes only the
ContinuityDB-owned entry:

```bash
continuitydb agents disconnect codex --project-dir "$PWD"
continuitydb agents disconnect codex --project-dir "$PWD" --apply
```

See [binary distribution and setup](docs/binary-distribution.md) for build,
checksum, remote transport, recovery, and platform details.

## Quick start from source

ContinuityDB has not been documented here as a published npm package. Install
the current repository source so the command you run matches the audited code.
Node.js 22.5 or newer is required.

```bash
git clone https://github.com/deva-prakash-j/continuitydb.git
cd continuitydb
npm ci
npm link

continuitydb init --home "$PWD/.continuitydb-demo"
continuitydb doctor --home "$PWD/.continuitydb-demo"
```

All finite CLI commands emit JSON. `serve` and `mcp` remain attached until the
process receives `SIGINT` or `SIGTERM`.

ContinuityDB starts in lexical-plus-graph mode. To enable local semantic
retrieval without sending memory or query text to a provider, prefetch the
pinned model, switch the provider to `local`, and backfill existing active
memories:

```bash
continuitydb embeddings-pull --home "$PWD/.continuitydb-demo"

CONTINUITYDB_EMBEDDING_PROVIDER=local \
CONTINUITYDB_LOCAL_MODEL_OFFLINE=true \
continuitydb embeddings-index --home "$PWD/.continuitydb-demo"
```

The pull downloads the pinned 34.2 MB quantized model and vocabulary, verifies
their SHA-256 digests, and caches them privately below the selected home. New
active memories are embedded automatically whenever the running CLI, MCP, or
HTTP process also has `CONTINUITYDB_EMBEDDING_PROVIDER=local`. Keep
`CONTINUITYDB_LOCAL_MODEL_OFFLINE=true` after the pull to prevent runtime
downloads. Use `npm ci --omit=optional` for a smaller lexical/graph-only
installation that excludes the WASM inference runtime.

| Retrieval mode | Setup | Text leaves the host? | Intended use |
|---|---|---:|---|
| Lexical + graph | Default; optional dependencies may be omitted | No | Exact identifiers, paths, symbols, citations, and dependency traversal |
| Local hybrid | `CONTINUITYDB_EMBEDDING_PROVIDER=local` | No | Exact plus conceptual/paraphrase retrieval on one machine |
| Ollama hybrid | Provider `ollama` with a configured model | Only to the configured endpoint | Existing local Ollama installations |
| OpenAI-compatible hybrid | Provider `openai-compatible` with an explicit endpoint/model | Yes, to the configured endpoint | Operator-managed remote embedding services |

## Try automatic context transfer

Agent A captures short-lived working context. Server policy—not the agent—sets
its source trust, scope, status, and maximum lifetime.

```bash
CONTINUITYDB_OWNER_ID=demo-user \
CONTINUITYDB_AGENT_ID=agent-a \
continuitydb capture \
  --home "$PWD/.continuitydb-demo" \
  --project charge-api \
  --kind working \
  --body "Publish charge-schema before regenerating the charge-api client" \
  --idempotency-key charge-release-order-v1
```

Agent B, or a new session/provider using the same owner, can recall it:

```bash
CONTINUITYDB_OWNER_ID=demo-user \
CONTINUITYDB_AGENT_ID=agent-b \
continuitydb context "What is the release order?" \
  --home "$PWD/.continuitydb-demo" \
  --project charge-api \
  --allow-projects charge-api
```

Working memory expires automatically. Durable decisions and unverified claims
do not become active through this path without the required policy outcome.

## Automatic capture policy

The default policy promotes memory according to risk rather than requiring a
human for every write:

| Capture type | Default disposition |
|---|---|
| Project working context | Active with a policy-capped TTL, default maximum 24 hours |
| High-confidence project inference with stable `subject_key` | Active with a policy-capped TTL, default maximum 7 days |
| Exact Git excerpt with allowed ref, reachable commit, safe path, and matching SHA-256 | Active and durable when confidence meets policy |
| Low-confidence inference or unverifiable Git claim | Proposed for review |
| Global memory or agent-observed decision | Proposed for review |
| Conflicting subject or sensitive/restricted content | Quarantined |
| Credential-like content, forbidden project, or invalid scope | Rejected before persistence |

Agents cannot choose their tenant, owner, namespace, final status, trusted
source type, or approval state. Copy
[`examples/capture-policy.example.json`](examples/capture-policy.example.json)
to a private `0600` file and mount configured repositories read-only.

## Connect an MCP client

After the source installation, start the stdio server with a stable owner and a
distinct identity for each agent:

```bash
CONTINUITYDB_TENANT_ID=example-org \
CONTINUITYDB_PRINCIPAL_ID=copilot-agent-1 \
CONTINUITYDB_OWNER_ID=example-user \
CONTINUITYDB_AGENT_ID=copilot \
CONTINUITYDB_ALLOWED_PROJECTS=service-a,schema-a \
CONTINUITYDB_ALLOWED_SENSITIVITIES=public,private \
CONTINUITYDB_CAPTURE_POLICY_FILE=/absolute/private/path/capture-policy.json \
continuitydb mcp --home /absolute/private/path/continuitydb-data
```

The MCP surface is intentionally small:

| Tool | Required scope | MCP annotation | Purpose |
|---|---|---|---|
| `memory_search` | `memory:read` | read-only | Retrieve approved, scoped memories |
| `memory_context_pack` | `memory:read` | read-only | Build a cited, token-budgeted pack for a task |
| `handoff_latest` | `memory:read` | read-only | Retrieve the latest task/project/branch-applicable checkpoint |
| `memory_capture` | `memory:capture` | write, non-destructive | Submit memory through server-side risk policy |
| `handoff_checkpoint` | `memory:capture` | write, non-destructive | Save explicit structured continuation state |
| `memory_feedback` | `memory:feedback` | write, non-destructive | Record bounded helpful/incorrect/outdated feedback |

Tool discovery is scope-filtered. A read-only token receives only the three
read tools, all with `annotations.readOnlyHint: true`; this is the recommended
profile for GitHub Copilot code review.

### Use one central store from many MCP clients

Run one authoritative service. Modern clients connect directly to the stateful
Streamable HTTP MCP endpoint at `/mcp`:

```bash
# Authoritative service
CONTINUITYDB_ALLOWED_PROJECTS=service-a,schema-a \
continuitydb serve --home /absolute/private/path/continuitydb-data

# Configure the client with this endpoint and a host-owned bearer value:
# https://continuitydb.example/mcp
```

Clients limited to stdio can still launch a thin adapter:

```bash
# MCP process launched by a stdio-only client
CONTINUITYDB_HTTP_URL=http://127.0.0.1:7331 \
continuitydb mcp
```

Every HTTP MCP session is bound to the credential's tenant, principal, owner,
agent, scopes, project allowlist, and sensitivity allowlist. Reusing a session
ID with another credential returns HTTP 403. Sessions use random IDs, have an
idle TTL and capacity limit, and support explicit MCP `DELETE` termination.

Configure embeddings on the authoritative service only. Thin HTTP-backed MCP
adapters do not need the model runtime, cache, or provider credentials.

Remote service authentication supports private static bearer-token policies or
verified OIDC JWTs. OIDC requires `sub` and `continuitydb_tenant`; it accepts
optional `continuitydb_owner`, `continuitydb_agent`,
`continuitydb_projects`, `continuitydb_sensitivities`, and standard `scope` or
`scp` claims. Unknown scopes are ignored and absent project grants expose no
project memory. Do not put tokens in URLs, command arguments, repositories, or
visible logs. See the versioned configurations and evidence matrix in
[`examples/clients`](examples/clients) and
[`docs/client-compatibility.md`](docs/client-compatibility.md).

### Client compatibility evidence

| Client | Current evidence grade |
|---|---|
| MCP TypeScript SDK 1.30.0 | **Tool-call verified** over authenticated Streamable HTTP and stdio |
| Codex CLI 0.147.0 | **Transport verified** through initialization and `tools/list` |
| GitHub Copilot cloud agent / code review | **Contract tested** with a read-only three-tool allowlist |
| Claude Code | **Contract tested** for remote MCP plus `SessionStart` and `Stop` hooks |
| OpenCode | **Contract tested** for remote MCP, compaction context, and idle checkpointing |
| Cursor | **Contract tested** for the stdio adapter and lifecycle command shapes |

These grades intentionally distinguish real client execution from configuration
validation. Reproduce them with `npm run test:clients`,
`npm run validate:clients`, and `npm run test:codex-client`.

### Automatic session lifecycle adapters

`continuitydb-hook` retrieves the latest structured handoff plus a context pack
at session start. At stop/checkpoint it saves only the explicit structured JSON
file; it never mines raw transcripts.

Historical handoff records are excluded from the general context pack. Startup
injects exactly one separately addressed checkpoint selected by shared owner,
project, task and applicable branch. Private checkpoints receive the configured
working-memory TTL; sensitive and restricted checkpoints are quarantined until a
reviewer explicitly approves them. Per-agent/project capture quotas apply to
checkpoints as well, while exact idempotent retries remain allowed. The first
checkpoint for a task and branch uses `previous_checkpoint_id: null`; every
successor must name the current latest checkpoint. This compare-and-set lineage
quarantines stale or concurrent writers instead of replacing startup context.
Review approval repeats that comparison inside the same write transaction: a
held successor whose predecessor is no longer latest receives HTTP `409` and
remains held. A valid approval supersedes its predecessor, receives a fresh
monotonic sequence and activates with the configured bounded TTL. Quota slot
reuse is limited to same-agent replacement; a different agent continuing the
lineage consumes that agent's own project quota. Direct store commit/capture
calls cannot activate a handoff without these governance checks.

```bash
export CONTINUITYDB_HTTP_URL=http://127.0.0.1:7331
export CONTINUITYDB_PROJECT_ID=service-a
export CONTINUITYDB_TASK_ID=schema-v2-rollout
export CONTINUITYDB_BRANCH=feature/schema-v2

continuitydb-hook session-start
continuitydb-hook checkpoint --file .continuitydb-handoff.json --verbose
```

Start from [`examples/handoff.example.json`](examples/handoff.example.json).
Copy the relevant adapter shape for Claude Code, Cursor, or OpenCode:

- [`examples/claude-code-hooks.example.json`](examples/claude-code-hooks.example.json)
- [`examples/cursor-hooks.example.json`](examples/cursor-hooks.example.json)
- [`examples/clients/opencode-continuitydb.js`](examples/clients/opencode-continuitydb.js)

The examples follow the clients' lifecycle contracts: Claude Code receives
`hookSpecificOutput.additionalContext`, Cursor receives `additional_context`
JSON, and OpenCode injects bounded context during compaction and saves an
explicit checkpoint on `session.idle`. Cursor cloud agents currently do not run
`sessionStart`; use its MCP surface or a self-hosted/local session there.

Employers may disable custom MCP servers. Do not ingest employer repositories
or context unless organizational policy explicitly permits it.

## Link projects and retrieve dependency context

Project edges are explicit, directed, tenant-scoped, and constrained by the
caller's project allowlist.

```bash
continuitydb link-project charge-api charge-schema \
  --home "$PWD/.continuitydb-demo" \
  --relation depends-on \
  --provenance "charge-api build manifest"

continuitydb context "What changes after the schema contract changes?" \
  --home "$PWD/.continuitydb-demo" \
  --project charge-api \
  --allow-projects charge-api,charge-schema \
  --depth 2
```

Supported traversal relations currently include `depends-on`, `calls`,
`consumes`, and `imports`. Memory-to-memory edges can represent relationships
such as `supersedes`, `derived-from`, or application-defined typed relations.

## CLI reference

Run `continuitydb help` for the concise built-in usage text.

| Command | Purpose |
|---|---|
| `version` | Show CLI version, embedded runtime mode, platform, and architecture |
| `install` | Preview or apply a versioned user-scoped standalone-binary installation |
| `setup` | Initialize a vault and preview/apply detected or selected agent connections |
| `init` | Create a private local data directory and embedded database |
| `doctor` | Check Node version, directory permissions, SQLite/FTS5, and audit-chain health |
| `run` / `serve` | Start the foreground HTTP and Streamable MCP service |
| `agents detect` | Find supported client executables without running them |
| `agents status` | Report project connection state for all supported clients |
| `agents connect` | Preview/apply one or all project-scoped MCP configurations |
| `agents disconnect` | Preview/remove only the ContinuityDB-managed configuration |
| `mcp` | Start the stdio MCP server |
| `hook` | Run bundled Claude/Cursor lifecycle hook operations from the same binary |
| `propose` | Create a memory that remains invisible to recall |
| `capture` | Apply automatic capture policy as an agent identity |
| `commit` | Activate a proposed memory through the trusted CLI/admin path |
| `correct` | Create an active replacement and supersede the old version; handoffs use `--handoff-file` so structured and rendered state change together |
| `search` | Retrieve ranked memories |
| `context` | Build a cited, token-budgeted context pack |
| `handoff-save` | Validate and save a structured checkpoint JSON file |
| `handoff-latest` | Retrieve the newest checkpoint for a task and branch |
| `link-project` | Add a typed project dependency edge |
| `link-memory` | Add a typed memory edge |
| `feedback` | Record bounded helpful/incorrect/outdated feedback |
| `forget` | Tombstone a memory and remove it from recall |
| `stats` | Show lifecycle, graph, feedback, and audit counts for one tenant |
| `export` | Emit all canonical records as JSONL or create a new private output file |
| `audit-verify` | Verify the local audit hash chain |
| `repo-scan` | Safely inspect tracked repository files and optionally ingest records |
| `embeddings-status` | Show the built-in model revision, checksums, cache path, and readiness |
| `embeddings-pull` | Download and verify the pinned local model without embedding memory content |
| `embeddings-index` | Batch-index active memories missing the configured model projection |

Administrative CLI access is a trusted local boundary. Do not expose arbitrary
CLI execution to an agent merely because the MCP tools are restricted.

## Repository ingestion

Preview a tracked-file scan without persisting records:

```bash
continuitydb repo-scan /absolute/path/to/repo \
  --project charge-api \
  --include-records
```

Create proposals that remain invisible to recall:

```bash
continuitydb repo-scan /absolute/path/to/repo \
  --home "$PWD/.continuitydb-demo" \
  --project charge-api \
  --ingest
```

`--ingest --commit` is an explicit bulk approval action. Add `--since COMMIT`
for incremental scans. Limits can be set with `--max-files` and
`--max-file-bytes`; use `--no-docs` to omit documentation files.

The scanner reads blobs from the resolved commit tree, not working-directory
files, so an uncommitted edit cannot be cited as committed `HEAD` evidence. It
does not execute repository code. v0.6 uses bounded pattern-based
symbol and manifest extraction; sandboxed Tree-sitter workers remain planned.

## HTTP API

Start a loopback-only local service:

```bash
CONTINUITYDB_ALLOWED_PROJECTS=charge-api,charge-schema \
continuitydb serve \
  --home "$PWD/.continuitydb-demo" \
  --host 127.0.0.1 \
  --port 7331 \
  --review-ui
```

With `--review-ui`, open `http://127.0.0.1:7331/ui`. The opt-in loopback UI
lists proposed/quarantined memories, exposes citations and metadata, supports
correction/approval/rejection, and renders the exact context pack another agent
would receive. Enabling it grants the implicit loopback identity local review
authority; shared/network deployments should use an authenticated identity
policy and a trusted frontend boundary instead.

| Endpoint | Required scope |
|---|---|
| `GET /healthz` | Public liveness only |
| `GET /.well-known/oauth-protected-resource/mcp` | Public OIDC resource metadata when OIDC is configured |
| `POST`, `GET`, `DELETE /mcp` | Scope-filtered Streamable HTTP MCP session |
| `GET /readyz` | Authenticated identity |
| `POST /v1/search`, `POST /v1/context-packs`, `GET /v1/memories/{id}` | `memory:read` |
| `POST /v1/memories/captures` | `memory:capture` |
| `POST /v1/memories/{id}/feedback` | `memory:feedback` |
| `POST /v1/memories/proposals` | `memory:propose` |
| `POST /v1/memories/{id}/commit` | `memory:approve` |
| `GET /v1/memories` | `memory:approve` |
| `POST /v1/handoffs`, `GET /v1/handoffs/latest` | `memory:capture`, `memory:read` |
| corrections, held-memory revisions, deletion, graph links, and stats | `memory:admin` |
| `GET /metrics` | `metrics:read` |

The complete request and response contract is in
[`docs/openapi.yaml`](docs/openapi.yaml).

Loopback mode can use its configured local identity. A non-loopback bind refuses
to start without either a private token-policy file containing only SHA-256
token digests or a complete OIDC configuration, plus
`CONTINUITYDB_TRUST_PROXY_TLS=true`. Set that flag only when a trusted reverse
proxy actually terminates TLS. OIDC validates signature, issuer, audience,
expiry, subject, tenant and ContinuityDB authorization claims against the
configured JWKS. Static policies remain useful for private deployments; larger
installations should use OIDC workload identities or an mTLS-authenticating
gateway.

`memory:capture`, `memory:propose`, `memory:approve`, and `memory:admin` are
separate authorities. `memory:admin` is privileged and satisfies all scope
checks; do not assign it to agent identities.

## Configuration reference

### Identity, storage, and service

| Variable | Default | Purpose |
|---|---|---|
| `CONTINUITYDB_HOME` | `./.continuitydb` | Canonical records, embedded index, and audit location |
| `CONTINUITYDB_HOST` | `127.0.0.1` | HTTP bind address |
| `CONTINUITYDB_PORT` | `7331` | HTTP port |
| `CONTINUITYDB_TENANT_ID` | `local` | Server-owned tenant scope |
| `CONTINUITYDB_PRINCIPAL_ID` | `local-user` or `local-agent` by interface | Authenticated caller attribution |
| `CONTINUITYDB_OWNER_ID` | principal ID | Stable memory owner shared across authorized agents |
| `CONTINUITYDB_AGENT_ID` | principal ID or unset by interface | Originating agent attribution |
| `CONTINUITYDB_ALLOWED_PROJECTS` | empty | Comma-separated project allowlist |
| `CONTINUITYDB_ALLOWED_SENSITIVITIES` | `public,private` | Comma-separated sensitivity allowlist |
| `CONTINUITYDB_CAPTURE_POLICY_FILE` | unset | Private JSON capture-policy path |
| `CONTINUITYDB_TOKEN_POLICY_FILE` | unset | Private HTTP token-policy path containing token digests |
| `CONTINUITYDB_OIDC_ISSUER` | unset | Expected HTTPS OIDC issuer; configure with audience and JWKS URL |
| `CONTINUITYDB_OIDC_AUDIENCE` | unset | Required JWT audience for ContinuityDB |
| `CONTINUITYDB_OIDC_JWKS_URL` | unset | HTTPS JWKS endpoint used to verify OIDC JWT signatures |
| `CONTINUITYDB_PUBLIC_URL` | unset | Canonical HTTPS service origin required whenever OIDC is configured, including loopback bind behind a reverse proxy |
| `CONTINUITYDB_TRUST_PROXY_TLS` | `false` | Assert trusted TLS termination for non-loopback service |
| `CONTINUITYDB_ENABLE_REVIEW_UI` | `false` | Enable the loopback approval/provenance/context-preview UI |
| `CONTINUITYDB_MAX_BODY_BYTES` | `1048576` | Maximum HTTP request body size |
| `CONTINUITYDB_MCP_CAPTURE_BURST` | `30` | MCP capture/feedback token-bucket capacity |
| `CONTINUITYDB_MCP_CAPTURE_PER_SECOND` | `0.5` | MCP capture limiter refill rate |
| `CONTINUITYDB_MCP_MAX_SESSIONS` | `1000` | Maximum live Streamable HTTP MCP sessions |
| `CONTINUITYDB_MCP_SESSION_TTL_MS` | `1800000` | MCP session idle expiry, bounded from 10 seconds to 24 hours |
| `CONTINUITYDB_MCP_SCOPES` | `memory:read,memory:capture,memory:feedback` | Comma-separated scopes for local stdio MCP tool discovery |
| `CONTINUITYDB_HTTP_URL` | unset | Make stdio MCP/lifecycle hooks use one authoritative HTTP service |
| `CONTINUITYDB_HTTP_TOKEN_ENV` | `CONTINUITYDB_HTTP_TOKEN` | Name of the host-injected service credential entry |
| `CONTINUITYDB_HTTP_TIMEOUT_MS` | `15000` | HTTP adapter request timeout |
| `CONTINUITYDB_PROJECT_ID`, `CONTINUITYDB_TASK_ID`, `CONTINUITYDB_BRANCH` | unset | Lifecycle hook scope |
| `CONTINUITYDB_HANDOFF_FILE` | unset | Explicit structured checkpoint file used by the stop hook |
| `CONTINUITYDB_HOOK_CLIENT` | `claude` | Lifecycle startup output shape; set `cursor` for Cursor JSON |

Policy files must not be readable or writable by group or other users. See the
[capture-policy](examples/capture-policy.example.json) and inert
[token-policy](examples/token-policy.example.json) shapes. Never commit usable
credentials or raw tokens.

### Semantic embeddings

Lexical plus graph retrieval works without an embedding model or network call.
Semantic retrieval is disabled by default rather than silently downloading a
model. For zero-API-cost semantic retrieval, ContinuityDB includes a
first-class local provider based on the MIT-licensed
`BAAI/bge-small-en-v1.5` model. Inference runs inside the process through WASM;
memory and query text do not leave the host.

| Variable | Values / purpose |
|---|---|
| `CONTINUITYDB_EMBEDDING_PROVIDER` | `none`, `local`, `ollama`, or `openai-compatible` |
| `CONTINUITYDB_EMBEDDING_MODEL` | Provider model identifier; required for Ollama/OpenAI-compatible modes |
| `CONTINUITYDB_EMBEDDING_ENDPOINT` | Ollama defaults to loopback `/api/embed`; required for OpenAI-compatible mode |
| `CONTINUITYDB_EMBEDDING_DIMENSIONS` | Optional requested dimensions for OpenAI-compatible providers |
| `CONTINUITYDB_EMBEDDING_API_KEY_ENV` | Name of a host-injected environment entry containing the provider credential |
| `CONTINUITYDB_ALLOW_REMOTE_EMBEDDINGS` | Must be `true` for a non-loopback endpoint |
| `CONTINUITYDB_MODEL_CACHE` | Override the built-in model cache root; defaults under `CONTINUITYDB_HOME/models` |
| `CONTINUITYDB_LOCAL_MODEL_OFFLINE` | `true` refuses model downloads and requires a verified cache |
| `CONTINUITYDB_LOCAL_MODEL_THREADS` | WASM threads, bounded from 1 to 8; default 1 |
| `CONTINUITYDB_LOCAL_MODEL_BATCH_SIZE` | Local inference batch, bounded from 1 to 64; default 32 |

#### Recommended local setup

```bash
# 1. Download and verify the two pinned artifacts.
continuitydb embeddings-pull --home /absolute/private/path/continuitydb-data

# 2. Confirm the cache location, revision, hashes, and readiness.
continuitydb embeddings-status --home /absolute/private/path/continuitydb-data

# 3. Create projections for active memories that predate local embeddings.
CONTINUITYDB_EMBEDDING_PROVIDER=local \
CONTINUITYDB_LOCAL_MODEL_OFFLINE=true \
continuitydb embeddings-index --home /absolute/private/path/continuitydb-data

# 4. Run every process that should capture or retrieve vectors with the same
#    provider and home/cache configuration.
CONTINUITYDB_EMBEDDING_PROVIDER=local \
CONTINUITYDB_LOCAL_MODEL_OFFLINE=true \
continuitydb serve --home /absolute/private/path/continuitydb-data
```

`embeddings-index` is idempotent: it only backfills active records missing the
current model/content-hash projection. After that, newly activated memories are
indexed automatically by processes using the configured provider. Switching
models does not silently reuse incompatible vectors because every projection
carries both the model ID and canonical content hash.

#### Model, footprint, and cache

The local provider uses a 384-dimensional q8 ONNX projection pinned to
repository revision `ea104dacec62c0de699686887e3f920caeb4f3e3`. The model
artifact and vocabulary total 34,245,934 bytes. Every first-use artifact is
downloaded over HTTPS from the fixed Hugging Face repository, size-bounded,
SHA-256 verified, atomically installed, and cached with private permissions.
Symlinked cache directories and non-regular artifact files are rejected.

The optional `onnxruntime-web` WASM dependency is about 137 MB unpacked in the
tested npm release, while model artifacts are not included in the npm tarball
or container image. A default install includes the runtime; a lexical-only
install can use `npm ci --omit=optional`. In the supplied container,
`CONTINUITYDB_HOME=/data`, so a persistent `/data` volume also persists the
verified model cache under `/data/models`. Prefetch before enabling offline
mode.

#### Retrieval behavior

Documents use normalized mean-pooled embeddings. Queries use BGE's recommended
retrieval prefix. Code identifiers are split at acronym and camel-case
boundaries before WordPiece tokenization; the model sequence is capped at 512
tokens. Hybrid retrieval fuses lexical, semantic, and graph candidates before
MMR and the final serialized context-pack budget are applied.

Remote embedding endpoints must use HTTPS. Endpoint URLs cannot contain
credentials, query strings, or fragments. ContinuityDB reads the configured
host-injected credential entry without logging it.

The embedded vector path is a bounded exact scan, not an ANN database. Team and
distributed deployments must use pgvector or a sharded vector backend with
filter-before-return isolation tests.

## Data model and retrieval contract

Every canonical record includes:

- **identity:** tenant, shared owner, and originating agent;
- **scope:** namespace, project, branch, and sensitivity;
- **content:** type, title, body, tags, and structured metadata;
- **source:** source type/URI, repository path, symbol, and Git commit;
- **time:** valid-from, valid-to, observed, created, updated, and expiry times;
- **quality:** confidence, importance, stale state, feedback, and version;
- **lifecycle:** status, supersession, content hash, and idempotency key.

Retrieval follows this order:

1. Resolve server-owned tenant, principal, owner, agent, project, and sensitivity policy.
2. Compute bounded project dependency closure inside the caller allowlist.
3. Filter lifecycle, scope, branch, validity, expiry, and stale state in each retriever.
4. Retrieve lexical and optional semantic candidates.
5. Expand bounded graph neighbors.
6. Fuse ranks with RRF and apply scope, trust, freshness, exact-score, and feedback signals.
7. Remove redundant evidence with MMR.
8. Pack within the caller's token budget using the full serialized envelope,
   titles, citations, metadata, and response structure—not memory bodies alone.

Every context pack warns that recalled memory is untrusted evidence. It never
grants tool permission or becomes executable policy.

## Storage and recovery

Embedded mode stores canonical Markdown records separately from SQLite indexes.
The index can be rebuilt from canonical records. Audit events form a hash chain
inside a transactionally serialized SQLite table, so processes sharing one home
cannot append from stale cached heads. Legacy JSONL migration validates and
preserves the original predecessor/event hashes. A broken historical chain or a
chain that conflicts with existing SQLite history is retained and reported
invalid rather than silently replaced with a newly valid-looking chain.
`continuitydb export` provides a portable JSONL snapshot.

Use an encrypted filesystem or volume, restrict the data directory to its owner,
and back up the full data directory while the writer is stopped. Application-level
encryption and remote signed audit checkpoints are not implemented in v0.6.

## Deployment and scale

| Mode | Intended envelope | Status |
|---|---:|---|
| Embedded SQLite/FTS5 | One developer, tens of agents, curated local corpus | Implemented and tested; synchronous mixed-write saturation is documented |
| Team PostgreSQL/pgvector | Hundreds of agents, tens of millions of records | Reference migrations only; runtime adapter pending |
| Distributed routed indexes | 10–20k+ agents, hundreds of millions to billions | Architecture target; not benchmark-proven |

The container image runs as UID/GID `10001` and includes a health check. Its
default non-loopback bind intentionally requires authentication policy and a
real trusted TLS proxy; a successful image build alone is not deployment proof.

Read [`docs/scalability.md`](docs/scalability.md) before making capacity claims.

## Benchmarks

Run functional quality and local capacity suites:

```bash
npm test
npm run benchmark:quality
npm run benchmark:scale

# Uses any configured embedding provider
npm run benchmark:hybrid

# Downloads/uses the pinned built-in model and runs the hybrid fixture
npm run benchmark:local

# Measures local initialization, batch latency, throughput, and RSS
npm run benchmark:local:performance

# Tests, OpenAPI parse, quality baseline, dependency audit, and package check
npm run release:check

# Versioned client contracts and real installed-Codex transport discovery
npm run test:clients
npm run test:codex-client
```

### Current measured evidence

The repeatable v0.3 mixed-workload benchmark used 10,000 memories across four
tenants and 50 projects, three full repetitions, and a traffic mix of 75% search,
15% context-pack, and 10% automatic capture.

| Concurrent HTTP clients | Median throughput | Search p95 | Context-pack p95 | Capture p95 |
|---:|---:|---:|---:|---:|
| 1 | 132.96 ops/s | 8.554 ms | 9.112 ms | 16.405 ms |
| 8 | 135.31 ops/s | 71.330 ms | 75.257 ms | 76.447 ms |
| 32 | 128.34 ops/s | 284.101 ms | 506.872 ms | 743.367 ms |

Across the three runs:

- median canonical ingest: **161.44 records/s**;
- median direct-search p95: **6.334 ms**;
- worst direct-search p99: **7.895 ms**;
- retrieval misses: **0**;
- tenant-isolation violations: **0**;
- HTTP failures: **0**.

Throughput plateaued while tail latency grew with concurrency. This is evidence
that the single-process synchronous embedded path saturates; it is not a
distributed-scale result. A diagnostic 100k attempt reached 39,024 records in
14 minutes 46 seconds at 99.2% of one CPU before it was deliberately stopped,
showing nonlinear canonical-ingest degradation that must be profiled and fixed.

Without an embedding provider, the fixture achieves 9/9 exact Recall@5 and 0/5
semantic Recall@5. With the pinned local BGE-small q8 model, three consecutive
runs each achieved 9/9 exact Recall@5, 5/5 semantic Recall@5, semantic MRR@5 of
0.55, and zero isolation violations.

On the 2026-09-10 test VM (Intel Xeon Silver 4416+, one WASM thread, Node
25.9.0), verified-cache/session initialization took 550.001 ms, warm single-text
p95 was 23.233 ms, 32-text batch p95 was 600.658 ms, throughput was 56.34
texts/second, and process RSS after the suite was 363.29 MiB. The full semantic
quality fixture also passed on Node 22.20.0.

These measurements are machine-specific. The 14-query quality fixture is a
regression gate, not broad retrieval evidence; larger held-out engineering,
multilingual, and code-heavy datasets are still required.

See the [methodology and verdict](docs/benchmark-report-2026-09-10.md),
[raw 10k result](benchmarks/results/embedded-10k-2026-09-10.json), and
[benchmark instructions](benchmarks/README.md). Local model methodology and
footprint are documented separately in
[local embedding evidence](docs/local-embeddings.md).

## Security model

Important shipped controls include:

- loopback default and fail-closed non-loopback startup;
- server-bound identity, allowlists, and split capture/approve/admin authority;
- filter-before-return tenant, owner, project, and sensitivity isolation;
- bounded request size, graph depth, candidate counts, vector dimensions, timeouts, and capture rates;
- recursive credential-pattern rejection and repository secret-path denylist;
- Git commit/ref/path/checksum/excerpt validation for durable Git facts;
- committed-blob repository ingestion and branch-scoped working knowledge;
- task/branch-scoped handoff idempotency, persisted retry responses, bounded
  checkpoint TTLs, deterministic checkpoint sequencing, compare-and-set lineage,
  same-agent-only quota slot reuse, transactional review approval, atomic quota
  enforcement, and structured correction;
- idempotent writes, conflict quarantine, expiry, supersession, and tombstones;
- serialized concurrent first-open bootstrap, transactionally serialized
  hash-chained audit log, legacy-chain preservation, and verifier;
- regular-file/no-follow validation for explicit lifecycle checkpoint inputs;
- pinned lockfile, minimal dependencies, CI audit, and non-root container.

Known gaps include application-level encryption, complete DLP, precise AST
parsing, signed audit checkpoints, Git staleness projection, distributed purge
acknowledgement, mTLS-native identity, and organization-specific OIDC rotation
and revocation operations.

Read [`SECURITY.md`](SECURITY.md) and the
[threat model](docs/threat-model.md) before network deployment. Report
vulnerabilities through GitHub's private security-advisory feature, not a public
issue.

## Current limitations

- Alpha APIs and record formats may change before 1.0.
- Embedded writes and queries share one synchronous process.
- Semantic retrieval is opt-in; the pinned local model is first-use downloaded rather than embedded in the npm tarball.
- The local vector path is an exact bounded scan, not billion-scale ANN.
- The centralized service still uses the embedded SQLite runtime; PostgreSQL
  migrations are a reference contract and no production adapter is wired yet.
- Claude Code/Cursor hooks require an explicit structured checkpoint file; raw
  transcript mining and passive screen capture remain intentionally excluded.
- Repository symbol extraction is pattern-based rather than AST-precise.
- Regex credential detection reduces common accidents but is not complete DLP.
- Local data relies on host/volume encryption.
- mTLS-native identity, projector freshness, distributed deletion, and chaos-tested failover remain pending.

The active roadmap is maintained in [`CHANGELOG.md`](CHANGELOG.md). Contributions
that close a documented limitation with tests and evidence are especially welcome.

## Project documentation

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | Embedded and distributed design, record model, retrieval, consistency |
| [OpenAPI](docs/openapi.yaml) | Versioned HTTP contract |
| [Client compatibility](docs/client-compatibility.md) | Evidence-graded Codex, Copilot, Claude Code, OpenCode and Cursor interoperability |
| [Scalability](docs/scalability.md) | Deployment envelopes, invariants, sharding plan, scale gates |
| [Threat model](docs/threat-model.md) | Assets, boundaries, threats, shipped controls, production requirements |
| [Benchmark report](docs/benchmark-report-2026-09-10.md) | Reproduction, hardware, raw metrics, saturation verdict |
| [Local embeddings](docs/local-embeddings.md) | Pinned model, setup, quality, performance, security, and footprint |
| [v0.4 verification](docs/build-verification-2026-09-10-v0.4.md) | Central MCP, handoff, UI, provenance, branch, budget and audit gates |
| [v0.5 verification](docs/build-verification-2026-09-10-v0.5.md) | Pinned local model, integrity, quality, footprint, and CLI backfill gates |
| [v0.6 verification](docs/build-verification-2026-09-11-v0.6.md) | Remote MCP, OIDC, client contracts, lifecycle adapters, and interoperability evidence |
| [Competitive research](docs/competitive-research-2026-09-09.md) | Existing projects, capability consolidation, differentiation |
| [Security policy](SECURITY.md) | Supported line and private reporting process |
| [Contributing](CONTRIBUTING.md) | Development and pull-request expectations |
| [Governance](GOVERNANCE.md) | Maintainer and decision model |
| [Code of Conduct](CODE_OF_CONDUCT.md) | Community participation rules |

## Contributing

Issues and pull requests are welcome. Please include a reproducible test or
benchmark for behavior and performance changes. Avoid real employer code,
credentials, private memory, or raw conversation exports in fixtures and issue
reports.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md),
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and [`GOVERNANCE.md`](GOVERNANCE.md)
before contributing.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
