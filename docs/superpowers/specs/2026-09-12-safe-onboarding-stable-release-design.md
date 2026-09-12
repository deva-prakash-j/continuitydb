# Safe Onboarding and Stable Release Design

**Date:** 2026-09-12

## Goal

Make ContinuityDB installation and project onboarding truthful and safe, then
publish the first stable `v0.7.0` release from the independently reviewed
implementation.

## Problems

The current installation can be summarized misleadingly by an orchestrating
agent because the install result exposes only `path_configured`; it does not say
that ContinuityDB never edited a shell profile or provide a precise next step.

Project setup currently falls back to `basename(projectDir)`. When setup is run
outside a trustworthy Git repository, a generic directory such as `default`
can become the only allowed project. The resulting connection is secure but
surprising, and users may be tempted to replace the strict allowlist with a
wildcard.

`--agents detected` correctly configures only installed supported clients, but
the result does not clearly separate detected clients, connected clients, and
supported clients that are absent.

The release workflow supports stable `v*` tags, but no stable version has been
published.

## Safety principles

- Never edit `.zshrc`, `.bashrc`, PowerShell profiles, or other shell startup
  files.
- Never infer an unrestricted project wildcard.
- Never silently use a generic working-directory basename when Git identity is
  unavailable.
- Connector files remain project-local and least-privileged.
- Existing vault and connector rollback guarantees remain unchanged.
- Stable publication happens only after local gates, native CI, and Astraea
  return terminal success for the exact candidate.

## Project identity

Create `src/project-identity.js` with a side-effect-free resolver:

```js
resolveProjectIdentity({ projectDir, explicitProject })
// => { id, root, source: "explicit" | "git", git_root }
```

When `explicitProject` is present, validate it with the existing project-ID
grammar and use it. Otherwise walk from `projectDir` toward the filesystem root
until a real directory or regular-file `.git` marker is found. Use the Git root
basename as the project ID. A `.git` symlink is rejected. When no Git root is
found, setup/connect fails before mutation with an actionable message requiring
`--project <id>`.

Nested directories inside one repository resolve to the same project ID and
root. Explicit IDs remain available for monorepos or organizations whose stable
project name differs from the directory name.

## Project registry

The vault `config.json` gains an optional `projects` array:

```json
{
  "projects": [
    { "id": "billing-api", "root": "/absolute/repo/path", "source": "git" }
  ]
}
```

`continuitydb projects list --home PATH` reads this registry. `continuitydb
projects add --project-dir PATH [--project ID] --home PATH --apply` previews or
atomically registers one project. Re-registering the same ID/root is
idempotent. The same ID with a different root is a conflict unless an explicit
future migration feature is designed; this release does not add a force
override.

Successful `setup --apply` registers the resolved project as part of the setup
transaction. A later connector failure restores the prior config bytes. A
preview reports the proposed identity but does not create or edit the vault.

The registry is not a global authorization wildcard. Each generated project
connector receives only its resolved project ID in
`CONTINUITYDB_ALLOWED_PROJECTS`. A user authorizes another repository by
running setup in that repository or by supplying an explicit project ID.

## Installer result contract

Install preview and apply results add:

```json
{
  "shell_profile_modified": false,
  "path_configured": false,
  "path_entry": "/home/user/.local/bin",
  "next_steps": ["export PATH=...", "continuitydb version"]
}
```

`next_steps` is platform-aware and contains no claim that the installer changed
the shell. When the launcher directory is already on `PATH`, the export step is
omitted. Existing result fields remain for compatibility.

## Setup result contract

Setup preview/apply output adds:

```json
{
  "project": { "id": "billing-api", "root": "/repo", "source": "git" },
  "agents": {
    "requested": "detected",
    "detected": ["opencode"],
    "connected": ["opencode"],
    "supported_not_installed": ["codex", "claude", "cursor", "copilot"]
  },
  "configuration_scope": "project"
}
```

The existing `connections` array remains available. For an explicit client
selection, `detected` still reports installed clients while `connected`
reflects the requested successful plans. No global client configuration is
created.

## Stable release

After the implementation is merged to `main`, create the annotated tag
`v0.7.0` at the exact reviewed merge commit and push it. The existing release
workflow must publish a non-prerelease GitHub Release with these six assets:

- `continuitydb-linux-x64` and `.sha256`
- `continuitydb-darwin-arm64` and `.sha256`
- `continuitydb-win32-x64.exe` and `.sha256`

The release is complete only after the tag target, stable/prerelease state,
asset set, sidecar checksums, and build provenance are independently verified.
Intel macOS remains npm/source-only because the documented upstream Node SEA
failure is unchanged.

## Compatibility and migration

- Existing connector configurations and vaults without `projects` remain valid.
- `projects` is optional and defaults to an empty list when absent.
- No existing project allowlist is broadened automatically.
- Existing rolling `main-<sha>` prereleases remain available.
- No shell profiles or unrelated client configurations are modified.

## Verification

- Unit tests for Git-root discovery, explicit identities, symlink rejection,
  outside-repo refusal, registry idempotency, and conflicts.
- CLI tests proving preview purity and transactional setup rollback.
- Installer tests for PATH-present and PATH-absent outputs on POSIX and Windows.
- Connector tests proving the generated allowlist contains exactly the resolved
  project ID and config paths remain project-local.
- Full `npm run release:check`, functional binary smoke, semantic smoke, and
  reproducible binary checks.
- Pull-request native CI on Linux x64, macOS arm64, and Windows x64.
- Astraea `PASS` on the immutable candidate before merge and stable tagging.

