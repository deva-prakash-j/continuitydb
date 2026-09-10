# Threat model

## Protected assets

- memory bodies, repository context and embeddings;
- tenant/project membership and relationship metadata;
- identity and authorization policy;
- audit history and deletion state;
- connector and embedding-provider credentials.

## Trust boundaries

Agent/model input, recalled memory, repository files, MCP arguments, HTTP bodies,
connector content and embedding responses are untrusted. A recalled statement is
evidence only; it cannot grant permissions, approve a write, change server policy,
or become a tool instruction.

## Primary threats and controls

| Threat | Controls shipped in v0.5 | Production requirement |
|---|---|---|
| Cross-tenant/owner retrieval | tenant and shared owner included in every local lookup; project/sensitivity ACLs centralized; adversarial tests | owner-aware DB row-level security, per-backend filter assertions, tenant-router tests |
| Agent self-approval | capture/propose/approve/admin scopes are split; MCP has no approve/admin tools; server chooses status and TTL | OIDC workload claims and organization policy distribution |
| Memory poisoning | project allowlists, bounded TTLs, confidence caps, atomic per-agent quota, compare-and-set handoff lineage, conflict quarantine and idempotency | semantic contradiction detection, anomaly detection, reputation and organization review queues |
| Sensitive handoff bypass | every checkpoint passes capture policy and per-agent/project quota; private checkpoints expire and sensitive/restricted checkpoints remain held for review | organization-specific classification and DLP |
| Prompt injection in memory | warning on every context pack; content never interpreted as policy | provenance UI, content-risk labels, tool planner separation |
| Credential ingestion | recursive common-pattern rejection before persistence and secret-path denylist | DLP provider, organization policy and incident flow |
| SSRF through embedding config | endpoints come from server config; remote endpoints opt-in and HTTPS-only | egress allowlist/proxy and DNS rebinding protection |
| Local model supply-chain drift | fixed repository and revision, size caps, pinned SHA-256 digests, atomic private cache, pinned WASM runtime | artifact attestations, SBOM and independent malware/model scanning |
| Token theft | only SHA-256 token digests in policy; constant-time comparison; no token logging | OIDC/mTLS, rotation, revocation, secret manager, TLS termination |
| DoS / memory exhaustion | request/body/candidate/vector/depth limits, timeouts, HTTP and MCP capture rate limits, per-agent/project record quota | distributed quotas, queue limits, circuit breakers and WAF |
| Symlink/path escape or dirty-worktree misattribution during repo scan | committed Git blobs only; symlink tree entries denied; secret paths filtered | sandboxed workers, read-only mounts, resource limits |
| Forged Git grounding | configured read-only root, allowed-ref ancestry, path, full-file SHA-256 and exact excerpt verification | signed ingest workers and organization-controlled repository attestations |
| Stale or contradicted context | lifecycle startup excludes historical handoffs from general retrieval and separately selects one latest task/project/branch checkpoint; successor handoffs must reference that checkpoint and concurrent stale writers are quarantined; valid-time, expiry, stale state, supersession and citations | semantic contradiction detection plus Git ancestor/symbol revalidation |
| Audit tampering/racing writers | SQLite-serialized hash chain with verifier; no cached per-process head; legacy hashes are validated and corruption is preserved/reported | append-only remote sink, signed checkpoints/WORM retention |
| Deletion incompleteness | tombstone removes local recall and invalidates embeddings by status/hash | purge coordinator with per-projection acknowledgements and SLO |
| Supply-chain compromise | pinned lockfile, minimal dependencies, CI audit, non-root container | provenance attestations, signed releases, dependency review, SBOM |

## Deployment rules

- The HTTP service binds to loopback by default. Its implicit local identity is
  read/capture/feedback only unless the operator explicitly enables the review
  UI, which adds local review authority for that process.
- A non-loopback bind refuses startup without a token policy and an explicit
  assertion that TLS terminates at the trusted proxy.
- Personal and employer data use separate tenants; higher-risk deployments should
  also use separate stores, keys and service identities.
- Token policy files and provider credentials are mounted by the host secret
  manager and never committed.
- The supplied token-policy file is an inert shape example, not a usable secret.

## Known v0.5 gaps

- Static token files do not provide enterprise lifecycle or revocation events.
- Local SQLite content is not application-level encrypted; use encrypted volumes.
- Regex secret detection is incomplete.
- Regex symbol extraction is less precise than sandboxed Tree-sitter workers.
- Hash chaining detects modification but does not prevent an attacker with storage
  access from replacing both the event table and its local head; remote signed checkpoints
  are needed.
