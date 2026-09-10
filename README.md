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

> **Project status:** v0.5 alpha. The embedded SQLite/FTS5 mode is implemented,
> tested, and suitable for local evaluation. The repository includes a
> PostgreSQL/pgvector reference schema and distributed architecture, but the
> production adapter and billion-record proof do not exist yet.

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

## Implemented in v0.5

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

- six agent-facing MCP tools, including structured handoff save/retrieval;
- HTTP-backed stdio MCP mode so many clients can share one authoritative service;
- lifecycle hook adapter plus Claude Code and Cursor configuration examples;
- opt-in local review inbox for approval, correction, provenance inspection, and context preview;
- versioned HTTP API with server-bound identity and scoped authorization;
- CLI for setup, health checks, capture, lifecycle, retrieval, graph links,
  repository scanning, export, statistics, and audit verification;
- Git committed-blob scanner with incremental mode, symlink rejection, file
  limits, and a secret-path denylist; dirty worktree content is never attributed to `HEAD`;
- OpenAPI contract, tests, benchmarks, CI, non-root container, threat model,
  security policy, contribution guide, and governance document;
- 64-partition PostgreSQL/pgvector reference migrations with owner-aware row-level security.

See the [architecture](docs/architecture.md) and
[competitor-derived capability review](docs/competitive-research-2026-09-09.md)
for design details and deliberate exclusions.

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

| Tool | Purpose | Can change lifecycle or permissions? |
|---|---|---|
| `memory_search` | Retrieve approved, scoped memories | No |
| `memory_context_pack` | Build a cited, token-budgeted pack for a task | No |
| `memory_capture` | Submit memory through server-side risk policy | Cannot approve, delete, correct, or change scope |
| `memory_feedback` | Mark a visible memory helpful, incorrect, or outdated | No; ranking influence is bounded |
| `handoff_checkpoint` | Save goal/state/completed work/questions/next actions/files as one checkpoint | Cannot approve other memories or change permissions |
| `handoff_latest` | Retrieve the latest task/project/branch-applicable checkpoint | No |

Use [`examples/mcp.vscode.example.json`](examples/mcp.vscode.example.json) as a
VS Code/Copilot-compatible starting point. Other clients can launch the same
stdio command using their MCP configuration format.

### Use one central store from many MCP clients

Run one authoritative service, then make each local stdio MCP process a thin
HTTP adapter instead of constructing its own `ContextVault`:

```bash
# Authoritative service
CONTINUITYDB_ALLOWED_PROJECTS=service-a,schema-a \
continuitydb serve --home /absolute/private/path/continuitydb-data

# MCP process launched by each client
CONTINUITYDB_HTTP_URL=http://127.0.0.1:7331 \
continuitydb mcp
```

Configure embeddings on the authoritative service only. Thin HTTP-backed MCP
adapters do not need the model runtime, cache, or provider credentials.

For a remote HTTPS service, set `CONTINUITYDB_HTTP_TOKEN_ENV` to the name of a
host-injected credential entry. Do not put a token in the URL, MCP arguments,
repository, or visible logs. The client rejects plaintext non-loopback URLs.
See [`examples/mcp.remote.vscode.example.json`](examples/mcp.remote.vscode.example.json).

### Automatic session lifecycle adapters

`continuitydb-hook` retrieves the latest structured handoff plus a context pack
at session start. At stop/checkpoint it saves only the explicit structured JSON
file; it never mines raw transcripts.

Historical handoff records are excluded from the general context pack. Startup
injects exactly one separately addressed checkpoint selected by shared owner,
project, task and applicable branch. Private checkpoints receive the configured
working-memory TTL; sensitive and restricted checkpoints are quarantined until a
reviewer explicitly approves them. Per-agent/project capture quotas apply to
checkpoints as well, while exact idempotent retries remain allowed.

```bash
export CONTINUITYDB_HTTP_URL=http://127.0.0.1:7331
export CONTINUITYDB_PROJECT_ID=service-a
export CONTINUITYDB_TASK_ID=schema-v2-rollout
export CONTINUITYDB_BRANCH=feature/schema-v2

continuitydb-hook session-start
continuitydb-hook checkpoint --file .continuitydb-handoff.json --verbose
```

Start from [`examples/handoff.example.json`](examples/handoff.example.json).
Copy the relevant hook shape into Claude Code or Cursor:

- [`examples/claude-code-hooks.example.json`](examples/claude-code-hooks.example.json)
- [`examples/cursor-hooks.example.json`](examples/cursor-hooks.example.json)

The examples follow the clients' command-hook contracts: Claude Code receives
plain `SessionStart` stdout as context, while Cursor receives
`additional_context` JSON. Cursor cloud agents currently do not run
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
| `init` | Create a private local data directory and embedded database |
| `doctor` | Check Node version, directory permissions, SQLite/FTS5, and audit-chain health |
| `serve` | Start the HTTP service |
| `mcp` | Start the stdio MCP server |
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
does not execute repository code. v0.5 uses bounded pattern-based
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
to start without both a private token-policy file containing only SHA-256 token
digests and `CONTINUITYDB_TRUST_PROXY_TLS=true`. Set that flag only when a
trusted reverse proxy actually terminates TLS. Static tokens are an alpha
adapter; production deployments need OIDC or mTLS.

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
| `CONTINUITYDB_TRUST_PROXY_TLS` | `false` | Assert trusted TLS termination for non-loopback service |
| `CONTINUITYDB_ENABLE_REVIEW_UI` | `false` | Enable the loopback approval/provenance/context-preview UI |
| `CONTINUITYDB_MAX_BODY_BYTES` | `1048576` | Maximum HTTP request body size |
| `CONTINUITYDB_MCP_CAPTURE_BURST` | `30` | MCP capture/feedback token-bucket capacity |
| `CONTINUITYDB_MCP_CAPTURE_PER_SECOND` | `0.5` | MCP capture limiter refill rate |
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
encryption and remote signed audit checkpoints are not implemented in v0.5.

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
  checkpoint TTLs, deterministic checkpoint sequencing, and structured correction;
- idempotent writes, conflict quarantine, expiry, supersession, and tombstones;
- transactionally serialized hash-chained audit log, legacy-chain preservation,
  and verifier;
- pinned lockfile, minimal dependencies, CI audit, and non-root container.

Known gaps include static-token lifecycle, application-level encryption,
complete DLP, precise AST parsing, signed audit checkpoints, Git staleness
projection, distributed purge acknowledgement, and production OIDC/mTLS.

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
- OIDC/mTLS, projector freshness, distributed deletion, and chaos-tested failover remain pending.

The active roadmap is maintained in [`CHANGELOG.md`](CHANGELOG.md). Contributions
that close a documented limitation with tests and evidence are especially welcome.

## Project documentation

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | Embedded and distributed design, record model, retrieval, consistency |
| [OpenAPI](docs/openapi.yaml) | Versioned HTTP contract |
| [Scalability](docs/scalability.md) | Deployment envelopes, invariants, sharding plan, scale gates |
| [Threat model](docs/threat-model.md) | Assets, boundaries, threats, shipped controls, production requirements |
| [Benchmark report](docs/benchmark-report-2026-09-10.md) | Reproduction, hardware, raw metrics, saturation verdict |
| [Local embeddings](docs/local-embeddings.md) | Pinned model, setup, quality, performance, security, and footprint |
| [v0.4 verification](docs/build-verification-2026-09-10-v0.4.md) | Central MCP, handoff, UI, provenance, branch, budget and audit gates |
| [v0.5 verification](docs/build-verification-2026-09-10-v0.5.md) | Pinned local model, integrity, quality, footprint, and CLI backfill gates |
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
