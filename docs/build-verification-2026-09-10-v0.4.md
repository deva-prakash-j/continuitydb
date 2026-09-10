# ContinuityDB v0.4 local verification — 2026-09-10

## Scope

This verification covers the continuity gaps addressed after v0.3: one
authoritative HTTP-backed MCP path, structured lifecycle handoffs, a review
inbox, committed Git provenance, branch isolation, full-response budget
accounting, and multi-process audit ordering.

## Gates

| Gate | Evidence | Result |
|---|---|---|
| Unit/integration suite | `npm test` | 40/40 pass |
| Central service | authenticated `ContinuityApiClient` plus stdio MCP proxy integration tests | pass |
| Cross-client lifecycle | Claude plain-context and Cursor `additional_context` hook outputs | pass |
| Structured handoff | save/latest task + project + owner + branch test | pass |
| Review workflow | list, inspect, revise, approve quarantined, reject route coverage | pass |
| Repository provenance | dirty worktree differs from `HEAD`; scanner returns committed blob only | pass |
| Branch isolation | lexical, semantic-candidate, and graph paths reject other branches | pass |
| Context budget | full serialized search/context response stays within requested estimate, including 64-token boundary | pass |
| Audit coordination | two `ContextVault` instances append one valid SQLite-serialized hash chain | pass |
| Legacy audit migration | JSONL events import once into the serialized table | pass |
| OpenAPI | `npm run validate:openapi` | 18 paths parsed |
| Dependency audit | `npm audit --omit=dev` | 0 known vulnerabilities |
| Package | `npm pack --dry-run` | 50 files, both CLI bins included |
| Mixed workload smoke | 200 records, 80 direct queries, 1/4 HTTP clients | 0 misses, 0 isolation violations, 0 HTTP failures |
| README/examples | 32 local links, all example JSON, embedded review UI script | pass |

## Retrieval truthfulness

The model-free lexical fixture remains 9/9 exact Recall@5 and 0/5 semantic
Recall@5 with zero isolation leaks. Conceptual developer questions require a
configured embedding provider; v0.4 does not misrepresent lexical search as
semantic retrieval. Structured handoff retrieval uses exact task/project/branch
identity and therefore does not depend on ranking.

## Not locally claimed

- No new 10k/100k performance claim was generated for v0.4; the README keeps
  the published v0.3 benchmark labeled as historical evidence.
- Container CI has not run for this unpushed commit.
- The review UI route and JavaScript are automated-test/parse validated, but a
  human browser visual pass is not claimed here.
