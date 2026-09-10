# Build verification

Date: 2026-09-09
Version: 0.2.0 alpha

## Guarded build record

| Checkpoint | Evidence | Result |
|---|---|---|
| Input/scope | Public open-source engineering-memory service; external publish explicitly authorized | pass |
| Competitor/license audit | 10 public repositories checked; features and source links recorded in competitive research | pass |
| Unit/integration/security | Node test runner, 18 tests | pass |
| MCP boundary | SDK client handshake; exactly `memory_search` and `memory_context_pack` | pass |
| OpenAPI | YAML parse and required-route assertions; 11 paths | pass |
| Dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Package | `npm pack --dry-run`; 33 files, 50.2 kB tarball | pass |
| Git hygiene | staged-tree whitespace check | pass |
| Secret-pattern scan | private-key and common provider-token patterns; synthetic fixture excluded by construction | pass |
| CLI smoke | init, doctor, propose and audit verification in isolated temp directory | pass |
| Container | Docker build attempted | blocked: runtime user cannot access Docker socket |
| GitHub publication | native identity and `gh auth status` checked | blocked: no connected GitHub identity or Git author |

## Retrieval evidence

Lexical quality fixture:

- exact Recall@5: 9/9;
- semantic Recall@5 without an embedding provider: 0/5;
- project isolation violations: 0/2.

The semantic result is deliberately reported as a failure, not hidden. Hybrid
retrieval plumbing is covered by a deterministic adapter test. A publishable
semantic score requires running `npm run benchmark:hybrid` with a named real
embedding model.

10,000-record v0.2 synthetic run:

- proposal+commit ingestion: 132 records/second;
- search p50: 2.450 ms;
- search p95: 3.077 ms;
- search p99: 3.984 ms.

Hardware/environment details were not captured by the legacy benchmark script,
so these numbers are local regression evidence only. They are not a global-scale
claim.

## Side-effect queue

The public repository creation/push is the only pending external side effect. It
was not attempted after the GitHub identity pre-check failed. No remote repository,
package, release, issue or message was created.

## Verdict

The embedded v0.2 alpha is locally releasable. Public release remains held until
GitHub identity is connected and CI, including the container build, succeeds on
the exact pushed commit.
