# Build verification — 2026-09-10

Version: 0.3.0 alpha

## Release assertions

| Assertion | Evidence | Result |
|---|---|---|
| Automatic transfer | Working capture became active and was recalled by the same owner scope | pass |
| Identity binding | Tenant, owner, principal and agent are server-derived; cross-owner recall returned zero | pass |
| Agent authority | MCP exposes capture/feedback but no approve, correct, delete, graph-admin or scope tools | pass |
| Risk promotion | Working/inference TTLs are capped; decisions held; conflicts/high sensitivity quarantined | pass |
| Git trust | Auto-activation requires configured root, allowed-ref reachability, path, SHA-256 and exact excerpt match | pass |
| Secret rejection | Recursive nested metadata test leaves zero record and zero audit residue | pass |
| Retry/abuse | Per-agent idempotency, HTTP rate limit, MCP capture rate limit and per-agent/project quota present | pass |
| API contract | OpenAPI 3.1 parsed and version matches package manifest | pass |
| Package | `npm pack --dry-run` produced a 39-file, 60.8 kB package | pass |
| Dependencies | `npm audit --omit=dev` | zero known vulnerabilities |

## Test and retrieval evidence

- Node test suite: 29/29 passing.
- Exact lexical Recall@5: 9/9.
- Semantic Recall@5 without an embedding provider: 0/5, intentionally reported.
- Scope isolation probes: 0 violations across 2 probes.
- 10,000-record synthetic run: 138 proposal+commit records/s; search p50
  2.098 ms, p95 2.311 ms and p99 3.721 ms.
- CLI smoke: init, policy capture and same-owner recall passed in an isolated store.
- JavaScript syntax checks and `git diff --check` passed.

## Limits

- The embedded result is not evidence for billion-record scale. PostgreSQL,
  pgvector and partition contracts are included, but the distributed runtime
  adapter and 1B-record load test remain release gates.
- Docker could not be built locally because this least-privilege VM user cannot
  access the Docker daemon. GitHub Actions contains the independent container gate.
- A real embedding model is still required for hybrid semantic quality evidence.
