# v0.6 interoperability verification — 2026-09-11

This record captures reproducible builder-side evidence. It does not approve
the release: readiness requires an independent Astraea `PASS` against the exact
immutable candidate commit.

## Evidence identity

- **Runtime candidate tested:** `2c9df0399dce5d31173aebe0769a81cf0dcc739b`
- **Verification date:** 2026-09-11
- **Runtime:** Node `v25.9.0`, npm `11.12.1`
- **Repository state:** `HEAD` exactly matched the runtime candidate and the
  worktree was clean after the verification commands completed.

This file is a documentation-only attestation created after the immutable
runtime candidate was tested. Its own later commit is not a replacement for the
tested runtime SHA above and does not modify runtime, test, package, or lockfile
content.

## Scope

- scope-filtered MCP tool discovery and safety annotations;
- authenticated stateful Streamable HTTP MCP at `/mcp`;
- static bearer and verified OIDC JWT identities;
- OAuth protected-resource metadata;
- Codex, GitHub Copilot, Claude Code and OpenCode configurations;
- Claude Code/Cursor lifecycle output and OpenCode plugin behavior;
- explicit checkpoint-file no-follow handling.

## Automated evidence

```bash
npm test
npm run test:security
npm run test:clients
npm run validate:openapi
npm run validate:clients
npm run test:codex-client
npm run benchmark:quality
npm audit --omit=dev
npm pack --dry-run
```

Observed results on the build host:

- **76/76** primary Node tests passed, with **0 failed** and **0 skipped**;
- the focused security subset passed **16/16**;
- the focused client interoperability subset passed **11/11**;
- OpenAPI parsed with **20 paths**;
- Codex, Copilot, Claude Code and OpenCode example contracts validated;
- installed `codex-cli 0.147.0` completed authenticated Streamable HTTP MCP
  `initialize` and `tools/list` against a disposable local server;
- exact lexical Recall@5 was **9/9** and isolation violations were **0**;
- production dependency audit reported **0 known vulnerabilities**;
- package dry-run completed with **71 files**, **122.2 kB** packed and
  **445.4 kB** unpacked.

## Security cases exercised

- MCP tools are omitted unless granted by the server-bound identity;
- every read tool declares `readOnlyHint: true` and non-destructive hints;
- MCP sessions reject cross-credential reuse and terminate explicitly;
- an active timer expires idle sessions without a subsequent request;
- session capacity includes in-flight initialization reservations, exercised
  with a deterministic pending-initialization barrier;
- shutdown marks the endpoint closed, closes pending runtimes, and waits for a
  deliberately paused initialization path to settle;
- static non-loopback deployments retain compatibility without OIDC metadata;
- OIDC verifies JWT algorithm, signature, issuer, audience, expiry, subject,
  tenant and scoped authorization claims;
- OIDC startup requires an explicit canonical HTTPS public origin even when the
  process binds to loopback behind a reverse proxy; discovery ignores `Host`;
- lifecycle checkpoint readers reject symlinks; inode/device checks guard the
  open path, but replacement-during-open is not claimed as separately tested.

## Evidence boundaries

The Codex run proves real client transport and discovery, not a model-triggered
tool call: standalone Codex model authentication is unavailable on this host.
GitHub-hosted Copilot, Claude Code and OpenCode binaries were not available;
their configurations and lifecycle contracts are tested locally but remain
labelled **contract tested**, not tool-call verified. See
[client compatibility](client-compatibility.md).

CI tied to the runtime candidate SHA was not available during this local
verification. Independent Astraea review remains the release gate and must cite
the exact reviewed base/head pair.
