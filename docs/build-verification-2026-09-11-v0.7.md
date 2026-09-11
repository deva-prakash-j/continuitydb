# v0.7 standalone binary verification — 2026-09-11

This record captures reproducible builder-side evidence for the standalone
binary and agent-setup candidate. It does not approve a release: readiness
requires an independent Astraea `PASS` against the exact immutable candidate.

## Evidence identity

- **Runtime candidate tested:** `b14cf051d532557ab1bb039617b42309723c0a8a`
- **Verification date:** 2026-09-11
- **Build host:** Linux `6.8.0-137-generic` x86_64
- **Build runtime:** Node `v25.9.0`, npm `11.12.1`
- **Linux binary:** `dist/continuitydb-linux-x64`
- **Linux binary size:** `143993896` bytes
- **Linux binary SHA-256:**
  `39a079fc1b0fa5b9d294a17eb6ccbf55302a277e94d95b880822d7a5bce5278f`
- **Repository state:** `HEAD` exactly matched the runtime candidate and the
  tracked worktree was clean after verification.

This file is a documentation-only attestation created after the immutable
runtime candidate was tested. Its later commit does not replace the tested
runtime SHA and does not modify runtime, tests, package metadata, lockfiles, or
release automation.

## Scope

- Node Single Executable Application build and self-install;
- global per-user vault initialization and health checks;
- preview-first, apply-gated agent configuration for Codex, GitHub Copilot,
  Claude Code, Cursor, and OpenCode;
- transactional multi-client preflight, commit, and rollback;
- fail-closed JSON/TOML parsing and managed-namespace validation;
- foreground HTTP service lifecycle and MCP six-tool discovery;
- capture followed by cross-client retrieval;
- embedded ONNX/WASM runtime integrity and real local semantic inference;
- native release workflow ordering, checksum generation, and immutable GitHub
  Action references.

## Automated evidence

The following gates were run against the exact runtime candidate:

```bash
npm test
npm run test:security
npm run test:clients
npm run validate:openapi
npm run validate:clients
npm run validate:release-workflow
npm run benchmark:quality
npm audit --omit=dev
npm run package:check
npm run test:codex-config
npm run test:binary
npm run test:binary:semantic
npm run test:binary:reproducible
```

Observed results on the build host:

- **108/108** primary Node tests passed with **0 failed** and **0 skipped**;
- the focused security subset passed **16/16**;
- the focused client interoperability subset passed **11/11**;
- OpenAPI parsed with **20 paths**;
- client adapter and release-workflow validators passed;
- exact lexical Recall@5 was **9/9** and isolation violations were **0**;
- production dependency audit reported **0 known vulnerabilities**;
- package dry-run on the runtime candidate completed with **85 files**,
  **147,307 bytes** packed and **536,382 bytes** unpacked;
- the generated Codex configuration was accepted by installed Codex CLI
  `0.147.0`;
- the Linux executable passed self-install, setup, HTTP readiness and clean
  shutdown, MCP initialization and six-tool discovery, capture, and retrieval;
- the Linux executable completed checksum-verified model loading and real local
  ONNX/WASM semantic inference.
- two independent clean-directory builds produced byte-identical Linux
  executables: **143,993,896 bytes**, SHA-256
  `39a079fc1b0fa5b9d294a17eb6ccbf55302a277e94d95b880822d7a5bce5278f`.

Clean-checkout reproducibility was verified in a new detached Git worktree at
the exact runtime SHA. Before the gate, `dist/continuitydb-linux-x64` did not
exist. A fresh `npm ci --ignore-scripts && npm run release:check` completed
successfully, built the executable required by the generated Codex
configuration probe, and was followed by functional and semantic smoke tests
against that same binary. The release gate therefore does not depend on a
cached developer-workspace `dist/` artifact.

## Remediations covered by this candidate

- `setup --apply` preflights every selected connector before mutation, builds a
  new vault in a private staging directory, atomically installs it, and removes
  that newly-created vault if the final connector transaction fails;
- for a pre-existing initialized vault, setup opens the existing database in
  immutable read-only mode and never snapshots, restores, or rewinds live
  SQLite files; a concurrent capture committed while setup is paused remains
  present after a later connector failure;
- only setup-owned configuration or internal model-cache paths are eligible for
  rollback, while connector configuration changes use their own reversible
  transaction;
- initialization failure occurs before connector mutation and removes only the
  setup artifacts created by the failed invocation, preserving pre-existing
  vault data and client configuration byte-for-byte;
- setup treats an external local-model cache as transactional state: a failed
  invocation removes newly downloaded model artifacts, restores overwritten
  pre-existing files byte-for-byte, and invalidates stale in-process cache
  verification state;
- multi-client operations preflight every target before any mutation;
- a later commit failure restores changed files and removes backup artifacts
  and empty directories created by the failed batch;
- malformed JSON/TOML or malformed managed namespaces fail closed;
- embedded WASM bytes are integrity checked and supplied in memory rather than
  extracted through a writable cache path;
- every CI or release workflow that uploads a native binary blocks publication
  until native functional and semantic binary smoke tests pass; macOS smoke
  tests run after signing;
- privileged release actions are pinned to immutable commit SHAs;
- the required `package:check` and `test:codex-config` release aliases are
  present and exercised; the generated Codex configuration probe builds its
  required standalone binary before use so it is reproducible from a clean
  checkout.
- Node SEA builds run from a stable versioned staging path, and
  `test:binary:reproducible` builds in two independent clean directories and
  rejects any byte or SHA-256 difference.

## Evidence boundaries

Only the Linux x64 executable was built and run on this host. macOS arm64 and
Windows x64 jobs are configured but are **not verified** until their
native GitHub runners complete terminal-green build, post-signing smoke,
semantic inference, checksum, and artifact-upload gates for the exact release
commit. Project-owned Developer ID and Authenticode signing identities are not
configured.

macOS x64 is intentionally unsupported for the v0.7 standalone binary because
upstream Node 25 SEA executables [segfault on Intel macOS](https://github.com/nodejs/node/issues/62893).
The npm distribution remains the supported Intel macOS installation path.

The 34.2 MB local embedding model is an integrity-pinned first-use download;
it is not bundled into the executable. The executable includes its Node runtime
and ONNX/WASM inference runtime and does not require Node.js or npm on the
destination host.

GitHub CI tied to the runtime candidate SHA was not available during this local
verification. Independent Astraea review remains the release gate and must cite
the exact reviewed base/head pair and this runtime evidence SHA.
