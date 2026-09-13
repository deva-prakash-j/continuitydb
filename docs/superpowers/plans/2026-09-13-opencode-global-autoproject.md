# OpenCode Global Auto-Project Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install one global OpenCode plugin that automatically registers every opened trusted Git repository and provides project-scoped ContinuityDB recall and governed capture without per-repository setup.

**Architecture:** Add an atomic root-to-project ensure operation to the registry, render a user-level OpenCode plugin whose tools derive project identity from host context, and install/migrate it transactionally through a new CLI command. The plugin talks only to a fixed local ContinuityDB executable and never accepts model-supplied project administration inputs.

**Tech Stack:** Node.js ESM, OpenCode JavaScript plugin API, existing ContinuityDB CLI/store/connector primitives, `node:test`, SEA binaries, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-13-opencode-global-autoproject-design.md`

## Global Constraints

- No per-repository ContinuityDB command after one global installation.
- Only canonical Git roots beneath configured real workspace roots may register.
- No wildcard authorization or model-facing project-admin tool.
- No raw transcript, prompt, hidden reasoning, secret, or tool-log capture.
- All writes are previewable, ownership-checked, atomic, reversible, and private.
- Linux x64, macOS ARM64, and Windows x64 are blocking release targets.
- Only Astraea PASS clears merge and publication.

---

### Task 1: Atomic trusted-root project ensuring

**Files:**
- Modify: `src/project-registry.js`
- Create: `src/trusted-project.js`
- Modify: `src/project-identity.js`
- Create: `test/trusted-project.test.js`
- Modify: `test/project-registry.test.js`

**Interfaces:**
- Produces: `ensureTrustedProject(home, { directory, worktree, workspaceRoots, apply }) -> { project, changed, applied }`
- Produces: `projectIdForCanonicalRoot(root, registeredProjects) -> string`

- [ ] Write tests proving reuse by root, basename selection, deterministic hash suffix collisions, concurrent ensures, Windows casing, nested paths, outside-root denial, `.git` symlink denial, and preview purity.
- [ ] Run `node --test test/trusted-project.test.js test/project-registry.test.js` and verify the new cases fail because the interfaces do not exist.
- [ ] Implement canonical trusted-root validation, containment, collision-safe IDs, and one-lock registration.
- [ ] Run the focused tests and require zero failures.
- [ ] Commit only Task 1 files with `feat: ensure trusted OpenCode projects atomically`.

### Task 2: Global OpenCode plugin renderer

**Files:**
- Create: `src/opencode-global-plugin-template.js`
- Create: `test/opencode-global-plugin.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ensureTrustedProject` through the CLI command from Task 3.
- Produces: `renderGlobalOpenCodePlugin({ executable, home, workspaceRoots, tenantId, ownerId, sensitivities }) -> string`

- [ ] Add the exact OpenCode plugin SDK version used for generated-plugin contract tests as a dev dependency.
- [ ] Write tests that import the generated plugin with OpenCode's real tool definitions and prove initialization ensures one project, first-task system context is injected once per task, compaction refreshes context, and custom tools never accept `project_id`.
- [ ] Write tests proving `continuitydb_remember` uses governed capture, search/context are exact-project scoped, prompt text remains in memory only, plan-mode config enables only `continuitydb_*`, and a second repo cannot access the first repo's memory.
- [ ] Write failure tests for oversized/invalid child output, timeout, executable drift, untrusted roots, symlink substitution, and secret-looking capture.
- [ ] Run `node --test test/opencode-global-plugin.test.js` and verify RED failures for the missing renderer.
- [ ] Implement the generated plugin with bounded `execFile`, private environment, runtime config/tool hooks, in-place system prompt mutation, and structured logging.
- [ ] Run the focused tests and require zero failures.
- [ ] Commit Task 2 files with `feat: render global OpenCode memory plugin`.

### Task 3: Global installer, status, migration, and uninstall

**Files:**
- Create: `src/opencode-global-install.js`
- Modify: `src/cli.js`
- Modify: `src/agent-connectors.js`
- Create: `test/opencode-global-install.test.js`
- Modify: `test/cli.test.js`
- Modify: `test/agent-connectors.test.js`

**Interfaces:**
- Produces CLI commands:
  - `continuitydb opencode install --workspace-root PATH... [--opencode-config-dir PATH] [--home PATH] [--apply]`
  - `continuitydb opencode ensure --project-dir PATH --profile FILE --apply` (host-internal contract used by the managed plugin)
  - `continuitydb opencode status [--opencode-config-dir PATH] [--home PATH]`
  - `continuitydb opencode uninstall [--opencode-config-dir PATH] [--home PATH] [--apply]`

- [ ] Write CLI RED tests for repeated workspace roots, Windows paths, preview purity, idempotent apply, status, drift, unmanaged conflict, symlink parents, uninstall preservation, and exact JSON output.
- [ ] Write migration RED tests that scan only trusted roots, skip `.git`/vendor/generated directories, honor a fixed directory budget, disconnect only fingerprint-valid ContinuityDB-owned local OpenCode adapters, preserve unmanaged/drifted files, and restore migrated bytes when the global write fails.
- [ ] Run the focused CLI/installer tests and confirm failures identify the missing commands.
- [ ] Implement global config-dir resolution, ownership metadata, same-directory atomic writes, bounded migration discovery, transaction rollback, and CLI routing.
- [ ] Run focused installer/CLI/connector tests and require zero failures.
- [ ] Commit Task 3 files with `feat: install global OpenCode auto-project integration`.

### Task 4: Documentation, packaged proof, native CI, and v0.8.0

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/binary-smoke.js`
- Modify: `scripts/validate-client-adapters.js`
- Modify: `scripts/validate-release-workflow.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-binaries.yml`
- Create: `examples/clients/opencode-global-continuitydb.js`
- Create: `test/opencode-global-release.test.js`

**Interfaces:**
- Consumes all Tasks 1-3 public commands and generated assets.
- Produces published `v0.8.0` artifacts and user documentation.

- [ ] Bump package and lockfile versions to `0.8.0`; document the one-time command, trusted-root model, automatic behavior, migration, status, uninstall, and privacy boundary.
- [ ] Add validator RED mutations for missing global plugin example, weakened trusted-root checks, skipped generated-plugin execution, conditional/ignored native gates, and stale version text.
- [ ] Extend binary smoke to install the global plugin in a temporary OpenCode config directory, open two Git repos with colliding basenames, automatically register both, recall isolated context, perform governed capture, and uninstall without deleting memory.
- [ ] Add blocking generated-plugin execution to general CI and every native release target.
- [ ] Run `npm test`, `npm run release:check`, `npm run test:binary`, `npm run test:binary:semantic`, and `npm run test:binary:reproducible`; require terminal success.
- [ ] Request independent code review for Tasks 1-4, fix every P0/P1, and rerun affected plus full gates.
- [ ] Route the immutable candidate to Astraea with exact base/head, acceptance criteria, local commands, and native constraints; only PASS proceeds.
- [ ] Push a draft PR, require exact-head Linux/macOS ARM64/Windows hosted gates, independently verify artifact checksums/provenance, merge the reviewed tree, and wait for exact-main CI.
- [ ] Create protected annotated tag `v0.8.0`; verify public non-draft/non-prerelease release, exact six assets, checksums, provenance, tag target, and installation instructions.
