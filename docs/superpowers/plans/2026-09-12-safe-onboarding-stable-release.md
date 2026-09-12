# Safe Onboarding and Stable Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Git-aware, least-privileged project onboarding and truthful installer/setup output, then publish audited stable release `v0.7.0`.

**Architecture:** A focused project-identity module resolves explicit or Git-derived IDs without mutation. A small project registry persists resolved identities in the existing vault config, while connector environments remain restricted to one project per project-local configuration. Installer and setup JSON results become self-explanatory without editing shell profiles.

**Tech Stack:** Node.js 22+, ESM, `node:test`, JSON/TOML project connector files, Node SEA, GitHub Actions, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-12-safe-onboarding-stable-release-design.md`

## Global Constraints

- Never edit shell startup files.
- Never infer or emit a wildcard project allowlist.
- Outside a Git repository, require explicit `--project <id>` before mutation.
- Keep connector files project-local.
- Preserve current transactional rollback and concurrency guarantees.
- Publish `v0.7.0` only after exact-head native CI and Astraea `PASS`.

---

### Task 1: Git-aware project identity

**Files:**
- Create: `src/project-identity.js`
- Create: `test/project-identity.test.js`
- Modify: `src/agent-connectors.js`

**Interfaces:**
- Produces: `validateProjectId(value: string): string`
- Produces: `resolveProjectIdentity({ projectDir: string, explicitProject?: string }): { id: string, root: string, source: "explicit" | "git", git_root: string | null }`
- Consumed by: setup, agent connect, and project registry tasks.

- [ ] **Step 1: Write failing identity tests**

```js
test("nested paths use the Git root basename", () => {
  const identity = resolveProjectIdentity({ projectDir: nested });
  assert.deepEqual(identity, { id: "billing-api", root, source: "git", git_root: root });
});

test("outside a Git repository requires an explicit project", () => {
  assert.throws(
    () => resolveProjectIdentity({ projectDir: root }),
    /cannot infer a project identity.*--project <id>/i,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test test/project-identity.test.js`

Expected: FAIL because `src/project-identity.js` does not exist.

- [ ] **Step 3: Implement the resolver**

```js
export function resolveProjectIdentity({ projectDir, explicitProject }) {
  const start = resolve(projectDir);
  if (explicitProject) return { id: validateProjectId(explicitProject), root: start, source: "explicit", git_root: findGitRoot(start) };
  const gitRoot = findGitRoot(start);
  if (!gitRoot) throw new Error(`cannot infer a project identity outside a Git repository; pass --project <id>`);
  return { id: validateProjectId(basename(gitRoot)), root: gitRoot, source: "git", git_root: gitRoot };
}
```

Implement `findGitRoot()` with filesystem traversal only. Accept a real
directory or regular file `.git`; reject symbolic links and other file types.

- [ ] **Step 4: Replace connector basename fallback**

Change connector option normalization so connect/setup receives a resolved
identity and uses `[identity.id]`. Do not change disconnect path behavior.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/project-identity.test.js test/agent-connectors.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/project-identity.js src/agent-connectors.js test/project-identity.test.js
git commit -m "feat: resolve safe project identities"
```

### Task 2: Transactional project registry and CLI

**Files:**
- Create: `src/project-registry.js`
- Create: `test/project-registry.test.js`
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`

**Interfaces:**
- Consumes: `resolveProjectIdentity()` from Task 1.
- Produces: `listRegisteredProjects(home: string): ProjectIdentity[]`
- Produces: `registerProject(home: string, identity: ProjectIdentity, { apply: boolean }): { changed: boolean, applied: boolean, projects: ProjectIdentity[] }`
- CLI: `projects list`; `projects add --project-dir PATH [--project ID] [--apply]`.

- [ ] **Step 1: Write failing registry tests**

```js
test("project registration previews without writing", () => {
  const result = registerProject(home, identity, { apply: false });
  assert.equal(result.changed, true);
  assert.equal(existsSync(join(home, "config.json")), false);
});

test("registration is idempotent and rejects one id at two roots", () => {
  registerProject(home, identity, { apply: true });
  assert.equal(registerProject(home, identity, { apply: true }).changed, false);
  assert.throws(() => registerProject(home, { ...identity, root: other }, { apply: true }), /already registered/);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/project-registry.test.js`

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement config-preserving registry writes**

Read `config.json` if present, treat missing `projects` as `[]`, preserve unknown
keys, and write mode `0600` through a same-directory temporary file followed by
rename. Acquire the canonical vault resource lock across read/validate/write.

- [ ] **Step 4: Add CLI commands and help text**

Add parsing for:

```text
continuitydb projects list [--home PATH]
continuitydb projects add --project-dir PATH [--project ID] [--home PATH] [--apply]
```

Both commands emit finite JSON. `list` is read-only; `add` defaults to preview.

- [ ] **Step 5: Register during successful setup**

Resolve the identity before setup mutation. Include registry changes inside the
existing setup snapshot/rollback boundary. Preview must not initialize a vault.
Connector failure must restore the original config bytes and registry state.

- [ ] **Step 6: Add CLI regression tests**

Add tests for Git-derived setup, outside-repo refusal before mutation, explicit
project setup, projects list/add, idempotency, and connector-failure rollback.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/project-registry.test.js test/cli.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/project-registry.js src/cli.js test/project-registry.test.js test/cli.test.js
git commit -m "feat: register project-scoped onboarding"
```

### Task 3: Truthful installer and setup results

**Files:**
- Modify: `src/self-install.js`
- Modify: `src/cli.js`
- Modify: `src/agent-connectors.js`
- Modify: `test/self-install.test.js`
- Modify: `test/cli.test.js`
- Modify: `test/agent-connectors.test.js`

**Interfaces:**
- Installer adds `shell_profile_modified`, `path_entry`, and `next_steps`.
- Setup adds `project`, `agents`, and `configuration_scope` while retaining
  `connections`.

- [ ] **Step 1: Write failing installer result tests**

```js
assert.equal(result.shell_profile_modified, false);
assert.equal(result.path_entry, result.launcherDirectory);
assert.match(result.next_steps[0], /export PATH=/);
assert.equal(onPath.next_steps.some((step) => /export PATH=/.test(step)), false);
```

Cover POSIX, Windows, preview, apply, PATH-present, and PATH-absent cases.

- [ ] **Step 2: Run installer tests and confirm failure**

Run: `node --test test/self-install.test.js`

Expected: FAIL on missing result fields.

- [ ] **Step 3: Implement platform-aware next steps**

Return `shell_profile_modified: false` unconditionally. Return the launcher
directory as `path_entry`. For POSIX PATH absence, return a process-local export
command; for Windows return a neutral instruction to add the directory through
user environment settings. Always include `continuitydb version` after PATH is
available.

- [ ] **Step 4: Write failing setup-summary tests**

Assert that a detected-only OpenCode environment reports OpenCode in
`detected`/`connected`, all other supported clients in
`supported_not_installed`, the resolved Git identity, and
`configuration_scope: "project"`.

- [ ] **Step 5: Implement setup summary without executing clients**

Reuse `detectAgents()` filesystem-only detection. Keep the existing
`connections` array. Never execute detected binaries and never create global
configuration.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/self-install.test.js test/cli.test.js test/agent-connectors.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/self-install.js src/cli.js src/agent-connectors.js test/self-install.test.js test/cli.test.js test/agent-connectors.test.js
git commit -m "feat: clarify install and agent setup results"
```

### Task 4: Documentation and migration guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/binary-distribution.md`
- Create: `docs/project-onboarding.md`

**Interfaces:**
- Documents the Task 1–3 CLI and JSON contracts.
- Supplies exact migration steps for users currently scoped to `default`.

- [ ] **Step 1: Update standalone installation guidance**

State that install never edits shell profiles and show the platform-aware
`next_steps` behavior. Remove any wording that can be summarized as both
“profile edited” and “profile untouched.”

- [ ] **Step 2: Add safe project onboarding guide**

Document:

```bash
cd /path/to/billing-api
continuitydb setup --agents detected --project-dir "$PWD" --apply
continuitydb projects list
```

For non-Git directories show `--project billing-api`. Explain that another repo
is added by running setup there, not by using `*`.

- [ ] **Step 3: Document client selection**

Explain `detected`, `all`, and explicit lists. State that absent clients are not
installed or configured and that generated files remain project-local.

- [ ] **Step 4: Validate examples and links**

Run: `npm run validate:clients && npm run validate:release-workflow && git diff --check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/binary-distribution.md docs/project-onboarding.md
git commit -m "docs: explain safe project onboarding"
```

### Task 5: Full QA, merge, and stable `v0.7.0`

**Files:**
- Modify after exact CI only: `docs/build-verification-2026-09-11-v0.7.md`

**Interfaces:**
- Consumes the complete implementation candidate.
- Produces a merged exact commit and stable GitHub Release `v0.7.0`.

- [ ] **Step 1: Run complete local gates**

```bash
npm run release:check
npm run build:binary
npm run smoke:binary
npm run smoke:binary:semantic
npm run test:binary:reproducible
```

Expected: every command exits 0; reproducible builds have identical SHA-256.

- [ ] **Step 2: Push a review branch and open a draft PR**

The PR body must describe the project-identity migration, shell-profile
non-mutation, compatibility, and exact verification commands.

- [ ] **Step 3: Verify exact-head CI**

Require terminal success for Node 22/24, container, Linux x64, signed macOS
arm64, and Windows x64 functional/semantic binary jobs. Pending or skipped
required jobs do not count.

- [ ] **Step 4: Obtain Astraea PASS**

Provide the immutable base/head pair, acceptance criteria, local commands, CI
URLs, platform limitation, and release procedure. Fix every P0/P1 and repeat
review until the exact candidate receives `PASS`.

- [ ] **Step 5: Merge and verify main**

Verify the PR state is `MERGED`, the merge commit tree matches the reviewed
tree, and exact-main CI/release workflows are terminal green.

- [ ] **Step 6: Create stable annotated tag**

```bash
git tag -a v0.7.0 <reviewed-main-sha> -m "ContinuityDB v0.7.0"
git push origin v0.7.0
```

- [ ] **Step 7: Verify stable release**

Verify `v0.7.0` targets the exact reviewed commit, `isPrerelease` is false, all
six assets exist, every sidecar validates its binary, and GitHub build
provenance resolves to the tagged commit.

- [ ] **Step 8: Record final evidence**

Update the v0.7 verification record with exact commit/tag/run URLs, native
artifact sizes and SHA-256 values, Astraea verdict, and any residual platform
limitation. Commit this evidence only if it does not move the already published
tag; otherwise keep the immutable release evidence in the GitHub Release and PR.

---

## Self-review

- Spec coverage: project identity, registry, least-privilege allowlists,
  installer truthfulness, agent summary, migration, native QA, and stable
  release each map to a task.
- Placeholder scan: no deferred implementation steps or unspecified tests.
- Interface consistency: all consumers use `resolveProjectIdentity`,
  `listRegisteredProjects`, and `registerProject` with the signatures defined
  above.

