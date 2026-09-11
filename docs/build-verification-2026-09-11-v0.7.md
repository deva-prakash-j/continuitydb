# v0.7 standalone binary verification — 2026-09-11

This record captures reproducible builder-side evidence for the standalone
binary and agent-setup candidate. It does not approve a release: readiness
requires an independent Astraea `PASS` against the exact immutable candidate.

## Evidence identity

- **Runtime candidate tested:** `20ef15ce1d6abbd8abc49306e5ea567e01766aed`
- **Verification date:** 2026-09-11
- **Build host:** Linux `6.8.0-137-generic` x86_64
- **Build runtime:** Node `v25.9.0`, npm `11.12.1`
- **Linux binary:** `dist/continuitydb-linux-x64`
- **Linux binary size:** `143989800` bytes
- **Linux binary SHA-256:**
  `406453c6666606cc9c5d9975e247d26bcfd4c8eaf947dba71b1b2c23a30af048`
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
```

Observed results on the build host:

- **101/101** primary Node tests passed with **0 failed** and **0 skipped**;
- the focused security subset passed **16/16**;
- the focused client interoperability subset passed **11/11**;
- OpenAPI parsed with **20 paths**;
- client adapter and release-workflow validators passed;
- exact lexical Recall@5 was **9/9** and isolation violations were **0**;
- production dependency audit reported **0 known vulnerabilities**;
- package dry-run completed with **84 files**, **142.5 kB** packed and
  **518.0 kB** unpacked;
- the generated Codex configuration was accepted by installed Codex CLI
  `0.147.0`;
- the Linux executable passed self-install, setup, HTTP readiness and clean
  shutdown, MCP initialization and six-tool discovery, capture, and retrieval;
- the Linux executable completed checksum-verified model loading and real local
  ONNX/WASM semantic inference.

## Remediations covered by this candidate

- `setup --apply` preflights every selected connector before mutation, builds a
  new vault in a private staging directory, atomically installs it, and removes
  that newly-created vault if the final connector transaction fails;
- initialization failure occurs before connector mutation and removes only the
  setup artifacts created by the failed invocation, preserving pre-existing
  vault data and client configuration byte-for-byte;
- multi-client operations preflight every target before any mutation;
- a later commit failure restores changed files and removes backup artifacts
  and empty directories created by the failed batch;
- malformed JSON/TOML or malformed managed namespaces fail closed;
- embedded WASM bytes are integrity checked and supplied in memory rather than
  extracted through a writable cache path;
- the release workflow blocks publication until native functional and semantic
  binary smoke tests pass; macOS smoke tests run after signing;
- privileged release actions are pinned to immutable commit SHAs;
- the required `package:check` and `test:codex-config` release aliases are
  present and exercised.

## Evidence boundaries

Only the Linux x64 executable was built and run on this host. macOS x64, macOS
arm64, and Windows x64 jobs are configured but are **not verified** until their
native GitHub runners complete terminal-green build, post-signing smoke,
semantic inference, checksum, and artifact-upload gates for the exact release
commit. Project-owned Developer ID and Authenticode signing identities are not
configured.

The 34.2 MB local embedding model is an integrity-pinned first-use download;
it is not bundled into the executable. The executable includes its Node runtime
and ONNX/WASM inference runtime and does not require Node.js or npm on the
destination host.

GitHub CI tied to the runtime candidate SHA was not available during this local
verification. Independent Astraea review remains the release gate and must cite
the exact reviewed base/head pair and this runtime evidence SHA.
