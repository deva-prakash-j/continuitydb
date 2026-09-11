# v0.7 standalone binary verification — 2026-09-11

This record captures reproducible builder-side evidence for the standalone
binary and agent-setup candidate. It does not approve a release: readiness
requires an independent Astraea `PASS` against the exact immutable candidate.

## Evidence identity

- **Runtime candidate tested:** `58e271b16f46c8e1d43ca14f64bac2f7e1225da4`
- **Verification date:** 2026-09-11
- **Build host:** Linux `6.8.0-137-generic` x86_64
- **Build runtime:** Node `v25.9.0`, npm `11.12.1`
- **Linux binary:** `dist/continuitydb-linux-x64`
- **Linux binary size:** `143997992` bytes
- **Linux binary SHA-256:**
  `ee07197bc063d32e6bb60005ec964e781e360fd8e70271a3483ac96b76bc1c06`
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

- **121/121** primary Node tests passed with **0 failed** and **0 skipped**;
- the focused security subset passed **16/16**;
- the focused client interoperability subset passed **11/11**;
- OpenAPI parsed with **20 paths**;
- client adapter and release-workflow validators passed;
- exact lexical Recall@5 was **9/9** and isolation violations were **0**;
- production dependency audit reported **0 known vulnerabilities**;
- package dry-run on the runtime candidate completed with **86 files**,
  approximately **151.6 kB** packed and **552.5 kB** unpacked;
- the generated Codex configuration was accepted by installed Codex CLI
  `0.147.0`;
- the Linux executable passed self-install, setup, HTTP readiness and clean
  shutdown, MCP initialization and six-tool discovery, capture, and retrieval;
- the Linux executable completed checksum-verified model loading and real local
  ONNX/WASM semantic inference.
- the Linux executable is **143,997,992 bytes**, SHA-256
  `ee07197bc063d32e6bb60005ec964e781e360fd8e70271a3483ac96b76bc1c06`.

## Native CI evidence

GitHub Actions ran the supported native matrix against exact head
`58e271b16f46c8e1d43ca14f64bac2f7e1225da4`:

- [release-binaries run 34622120306](https://github.com/deva-prakash-j/continuitydb/actions/runs/34622120306):
  Linux x64, post-sign macOS arm64, and Windows x64 all passed build,
  functional smoke, local semantic inference, checksum, and artifact upload;
- [CI run 34622120156](https://github.com/deva-prakash-j/continuitydb/actions/runs/34622120156):
  Node 22, Node 24, container, and Linux binary jobs all passed.

Downloaded artifact contents matched their uploaded SHA-256 sidecars:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| Linux x64 | 143,997,992 | `ee07197bc063d32e6bb60005ec964e781e360fd8e70271a3483ac96b76bc1c06` |
| macOS arm64 | 147,759,328 | `083d663eb58135635837d3f2849fcaf0f75c7e0053118fd21e844eb69c7ac25c` |
| Windows x64 | 110,745,088 | `c42374a62837fb4f99751d09b27673ad337ef9667c882e86347062b028da5d50` |

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
- setup and every local vault first-open share a re-entrant per-vault
  initialization lock, so rollback finishes before a concurrent first commit
  proceeds and can never delete that commit or its generated configuration;
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
- connector preflight and rollback use compare-and-swap snapshots; rollback
  restores only bytes written by the failed transaction and preserves a file
  changed by a concurrent writer while reporting the conflict;
- connector commits use crash-released SQLite transaction locks shared by all
  ContinuityDB processes and compare the preflight snapshot immediately before
  atomic replacement; arbitrary editors that do not participate in this lock
  protocol are detected on that final comparison when their write lands first,
  but cannot be given transactional guarantees across a later direct-write
  race by a portable filesystem API;
- the same SQLite-backed resource locks serialize model-cache and standalone
  installer critical sections, are re-entrant within one process, release
  automatically after process death, and have no stale lockfile unlink or PID
  reuse path;
- external model-cache rollback applies the same compare-and-swap rule and
  never overwrites a newer concurrent cache artifact;
- a later commit failure restores changed files and removes backup artifacts
  and empty directories created by the failed batch;
- malformed JSON/TOML or malformed managed namespaces fail closed;
- embedded WASM bytes are integrity checked and supplied in memory rather than
  extracted through a writable cache path;
- every CI or release workflow that uploads a native binary blocks publication
  until native functional and semantic binary smoke tests pass; macOS smoke
  tests run after signing;
- privileged release actions are pinned to immutable commit SHAs;
- standalone fresh installs and forced upgrades are transactional across the
  versioned binary, launcher, backup artifacts, and created directories;
  failure restores the prior installation while preserving a launcher changed
  concurrently and surfacing a rollback conflict;
- the required `package:check` and `test:codex-config` release aliases are
  present and exercised; the generated Codex configuration probe builds its
  required standalone binary before use so it is reproducible from a clean
  checkout.
- Node SEA builds run from a stable versioned staging path, and
  `test:binary:reproducible` builds in two independent clean directories and
  rejects any byte or SHA-256 difference.

## Evidence boundaries

Linux x64 was additionally built and run on the local verification host.
macOS arm64 and Windows x64 were verified on native GitHub-hosted runners for
the exact candidate head. macOS uses ad-hoc signing; project-owned Developer ID
and Windows Authenticode signing identities are not configured.

macOS x64 is intentionally unsupported for the v0.7 standalone binary because
upstream Node 25 SEA executables [segfault on Intel macOS](https://github.com/nodejs/node/issues/62893).
The npm distribution remains the supported Intel macOS installation path.

The 34.2 MB local embedding model is an integrity-pinned first-use download;
it is not bundled into the executable. The executable includes its Node runtime
and ONNX/WASM inference runtime and does not require Node.js or npm on the
destination host.

Independent Astraea review remains the release gate and must cite the exact
reviewed base/head pair and this runtime evidence SHA.
