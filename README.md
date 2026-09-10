# ContinuityDB

**Portable, Git-grounded context graph for AI agents.**

ContinuityDB keeps useful engineering context across repositories, sessions,
IDEs, agents and model providers. It retrieves a small, cited context pack from
lexical, semantic and dependency-graph signals while enforcing tenant, project,
sensitivity and temporal boundaries before content is returned.

> Status: **v0.3 alpha.** Embedded mode is executable and tested. A partitioned
> PostgreSQL/pgvector schema and global-scale design are included, but a
> billion-record deployment has not been load-proven. See
> [Scalability](docs/scalability.md).

## Why this exists

An AI coding client usually knows the open repository and current conversation.
It often loses the decision made last week, the dependency living in another
repository, the release order, or the branch/commit that made a fact true.
Changing clients makes that context gap worse.

ContinuityDB makes memory an independent evidence service:

```text
Copilot / Codex / Claude / Gemini / OpenClaw / custom agents
                              |
                         MCP or HTTP
                              |
      identity + ACL -> hybrid retrieval -> cited context pack
                              |
          canonical records + lexical/vector/graph indexes
```

## What is implemented

- local SQLite WAL store and FTS5/BM25 code-aware lexical search;
- optional Ollama or OpenAI-compatible embeddings;
- Reciprocal Rank Fusion, graph expansion, freshness/trust/scope boosts and MMR;
- tenant, shared-owner, principal, agent, namespace, project and sensitivity scopes;
- bi-temporal validity fields, expiry, supersession, correction and tombstones;
- project dependency edges and typed memory graph edges;
- Git commit/branch/path/symbol citations;
- policy-controlled automatic capture plus explicit proposal -> approval lifecycle;
- MCP tools for search, context packs, bounded capture and non-destructive feedback;
- versioned HTTP API with server-bound identity, rate limits and safe defaults;
- CLI for setup, diagnostics, lifecycle, graph links, export and repository scan;
- tracked-file Git scanner with incremental mode, path containment and secret-path denylist;
- tamper-evident local audit chain and verification;
- PostgreSQL/pgvector partition schema for the next distributed adapter;
- security threat model, OpenAPI contract, CI and a non-root container.

The full competitor-derived capability map and deliberate exclusions are in
[competitive research](docs/competitive-research-2026-09-09.md).

## Quick start

Requires Node.js 22.5 or newer.

```bash
npm install
npm link
continuitydb init --home "$PWD/.continuitydb"
continuitydb doctor --home "$PWD/.continuitydb"
```

Propose, approve and search a memory:

```bash
continuitydb propose \
  --home "$PWD/.continuitydb" \
  --project charge-api \
  --body "Publish charge-schema before regenerating the charge-api client" \
  --idempotency-key charge-release-order-v1

continuitydb commit MEMORY_ID --home "$PWD/.continuitydb"

continuitydb search "schema release order" \
  --home "$PWD/.continuitydb" \
  --project charge-api
```

`propose` never enters recall until a separate `commit`. Agents use `memory_capture`:
the server—not the model—binds identity and decides whether a capture becomes
active, proposed or quarantined. MCP never exposes commit, correct, delete, link,
scope changes or rebuild operations.

## Automatic agent memory

The same stable `CONTINUITYDB_OWNER_ID` lets multiple authenticated agents share
memory while `CONTINUITYDB_PRINCIPAL_ID` and `CONTINUITYDB_AGENT_ID` preserve actor
attribution. Capture promotion is risk-based:

| Capture | Default outcome |
|---|---|
| Project working context | active with a policy-capped TTL |
| High-confidence project inference with a stable `subject_key` | active with a policy-capped TTL |
| Exact Git excerpt verified against an allowed local ref, path and SHA-256 | active and durable |
| Global memory or decision | proposed for review |
| Conflict on the same live subject or high-sensitivity content | quarantined |
| Credential-like content or forbidden scope | rejected before persistence |

Copy [the capture policy example](examples/capture-policy.example.json) to a
private `0600` file. Project roots should be read-only mounts in production.

## Connect any MCP client

Start the stdio server:

```bash
CONTINUITYDB_TENANT_ID=personal \
CONTINUITYDB_PRINCIPAL_ID=copilot-agent-1 \
CONTINUITYDB_OWNER_ID=deva \
CONTINUITYDB_AGENT_ID=copilot \
CONTINUITYDB_ALLOWED_PROJECTS=charge-api,charge-schema \
CONTINUITYDB_CAPTURE_POLICY_FILE=/absolute/private/path/capture-policy.json \
continuitydb mcp --home /absolute/private/path/continuitydb-data
```

Use [the VS Code example](examples/mcp.vscode.example.json) for Copilot-compatible
configuration. Employers may disable custom MCP servers. Never ingest employer
code unless policy permits it; keep employer and personal tenants/stores separate.

## HTTP service

Local service:

```bash
continuitydb serve --home /absolute/private/path/continuitydb-data
```

- `GET /healthz`
- `GET /readyz`
- `POST /v1/search`
- `POST /v1/context-packs`
- controlled capture/feedback and proposal/approval/get/forget/graph administration under `/v1`
- `GET /metrics`

See [OpenAPI](docs/openapi.yaml). Loopback mode can use the local identity. A
non-loopback bind refuses to start unless a SHA-256 token policy is mounted and
trusted-proxy TLS termination is explicitly configured. Production deployments
should replace static tokens with OIDC or mTLS.

## Semantic retrieval

Semantic retrieval is opt-in; lexical + graph retrieval remains available
without a model or network call.

For a local Ollama-compatible endpoint, configure the provider and model in the
service environment. For an OpenAI-compatible endpoint, configure its URL, model,
and the **name** of the host-injected secret environment entry. ContinuityDB reads
that entry without logging it. Remote embedding endpoints require explicit opt-in
and HTTPS.

The embedded engine performs a bounded exact vector scan, appropriate only for
local corpora. Team/global deployments must use pgvector or a sharded ANN adapter.

## Repository ingestion

Preview a safe tracked-file scan:

```bash
continuitydb repo-scan /absolute/path/to/repo --project charge-api
```

Create proposals (still invisible to recall), or send scanner output through a
trusted capture worker:

```bash
continuitydb repo-scan /absolute/path/to/repo --project charge-api --ingest
```

Add `--since COMMIT` for incremental scans. `--commit` is an explicit bulk
approval action. v0.2 extracts common symbols and package manifests without
executing repository code; sandboxed Tree-sitter workers are the next precision
upgrade.

## Retrieval contract

1. Resolve server-owned tenant/principal/project policy.
2. Filter status, sensitivity, project closure, branch, validity, expiry and stale state.
3. Retrieve lexical and optional semantic candidates.
4. Expand bounded graph neighbors.
5. Fuse with RRF and apply scope, trust and freshness signals.
6. Remove redundant candidates with MMR.
7. Pack within the caller token budget and return source citations.

Memory text is always marked as untrusted evidence. It never grants tool
permission or becomes executable policy.

## Test and benchmark

```bash
npm test
npm run benchmark
npm run benchmark:quality
npm run benchmark:scale
# With a configured real embedding provider:
npm run benchmark:hybrid
npm run release:check
```

The original 10k synthetic lexical baseline was p95 **0.283 ms**, with 9/9 exact
Recall@5, 0/5 semantic Recall@5, and zero leaks in two scope probes. Those are
local synthetic results, not production claims. v0.2 adds hybrid plumbing and
security filters: its equivalent 10k run measured p50 **2.450 ms**, p95
**3.077 ms**, p99 **3.984 ms**, and 132 proposal+commit records/second. v0.3's
equivalent run, including feedback aggregation, measured p50 **2.098 ms**, p95
**2.311 ms**, p99 **3.721 ms**, and 138 records/second. The
additional isolation, temporal, graph-fusion and audit work is visible in the
latency rather than hidden. A configured real embedding model and a distributed
load harness are required before publishing semantic or billion-scale claims.

The first repeatable v0.3 mixed-workload run used 10k memories, four tenants,
three repetitions and 1/8/32 concurrent HTTP clients. It produced zero misses,
zero isolation violations and zero HTTP failures. Median throughput plateaued at
roughly 130 operations/second; at 32 clients, search p95 was **284.101 ms**,
context-pack p95 **506.872 ms**, and automatic-capture p95 **743.367 ms**. This
is evidence that the synchronous embedded service saturates under write-mixed
concurrency, not a distributed-scale claim. See the
[benchmark report](docs/benchmark-report-2026-09-10.md) and
[raw result](benchmarks/results/embedded-10k-2026-09-10.json).

Raw baseline output is under [`benchmarks/`](benchmarks/). Required global-scale
gates are defined in [Scalability](docs/scalability.md).

## Security

Read [SECURITY.md](SECURITY.md) and the [threat model](docs/threat-model.md) before
network deployment. Important defaults:

- loopback bind;
- non-root container;
- server-bound tenant, owner, principal and agent identity plus allowlists;
- request, graph-depth, candidate and vector limits;
- hash-only static token policy;
- credential-pattern rejection and secret-path denylist;
- split capture/approve/admin authority and policy-capped automatic writes;
- hash-chained audit log;
- fail-closed remote/TLS startup checks.

Local application-level encryption is not yet implemented. Use encrypted volumes
and a host secret manager.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
