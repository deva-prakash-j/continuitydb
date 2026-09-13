# OpenCode Global Auto-Project Integration Design

## Goal

Install ContinuityDB into OpenCode once per user account so every subsequently
opened Git repository beneath an explicitly trusted workspace root is
registered automatically and receives project-scoped recall and governed
memory tools without repository-local setup.

## User contract

The one-time command is:

```text
continuitydb opencode install --workspace-root PATH [--workspace-root PATH ...] --apply
```

It installs one user-level plugin in OpenCode's documented global plugin
directory. Opening a repository later requires no ContinuityDB command,
`opencode.json`, `.opencode/plugins` file, fixed `default` project, or static
MCP allowlist.

`continuitydb opencode status` reports the managed plugin, trusted roots,
executable, vault home, drift, and migrated local adapters.
`continuitydb opencode uninstall --apply` removes only assets whose ownership
fingerprint still matches and never deletes registered memory.

## Trust boundary

- Workspace roots are absolute, existing, canonical real directories.
- A repository is eligible only when its canonical Git root is contained by a
  configured workspace root. Windows containment is case-insensitive and
  separator-aware; POSIX containment is case-sensitive.
- Symlinked `.git` markers, symlink-substituted plugin parents, traversal,
  network URLs, wildcard roots, and repositories outside trusted roots fail
  closed.
- The plugin never accepts a `project_id` from the model. It derives identity
  from OpenCode's `worktree`/`directory` context and asks the host CLI to
  atomically ensure that exact Git root.
- Project registration remains local host administration. No project-admin
  MCP tool is exposed.

## Project identity

Registration is atomic under the existing vault initialization lock.

1. Reuse an existing registry entry whose canonical root matches.
2. Otherwise use the validated Git-root basename.
3. If that ID belongs to another root, append `-` plus the first twelve hex
   characters of SHA-256 over the platform-normalized canonical root.
4. Recheck the complete registry under the same lock and write config with the
   existing atomic/private config writer.

The mapping is stable across sessions and supports repositories with the same
basename in different workspace roots.

## Global plugin

The generated JavaScript plugin lives at:

```text
~/.config/opencode/plugins/continuitydb.js
```

or the directory selected by `--opencode-config-dir`. OpenCode documents this
directory as an automatically loaded user-level plugin location on all
platforms.

At plugin initialization it calls the fixed absolute ContinuityDB executable
with a private environment and bounded output. The command ensures the current
Git project under the embedded trusted roots and returns its canonical ID.

The plugin provides:

- automatic bounded context injection through
  `experimental.chat.system.transform` before the model handles a task;
- compaction context through `experimental.session.compacting`;
- `continuitydb_memory_search`, `continuitydb_context`, and
  `continuitydb_remember` custom tools whose project is fixed by the plugin;
- a runtime config hook that allows only `continuitydb_*` tools, including in
  plan/read-only agents, without enabling filesystem mutation tools;
- bounded in-memory task text for retrieval only; prompts are not persisted;
- governed capture through the existing capture policy. The model is instructed
  to save durable project decisions, verified facts, constraints, and reusable
  work state, but not raw transcripts, hidden reasoning, secrets, or tool logs.

Every CLI child process has a timeout, maximum output size, exact expected JSON
shape, fixed tenant/owner/agent identity, and an exact allowed project. Errors
are logged through OpenCode's application logger and fail memory operations
closed without blocking ordinary editing.

## Existing project-local adapters

The one-time installer scans only the configured workspace roots, with a hard
directory budget and standard generated/vendor directories skipped. It detects
only ContinuityDB-owned OpenCode adapters whose embedded ownership metadata and
fingerprints validate through the existing connector parser.

On apply, those adapters are disconnected transactionally before the global
plugin is committed. Unmanaged files, drifted managed files, symlinks, or
ambiguous ownership stop the migration before any write. If global plugin
installation fails, migrated project files are restored byte-for-byte.

Repositories without an old adapter are never modified.

## Ownership and updates

The global plugin starts with a versioned ownership header containing a
canonical configuration fingerprint. Preview is write-free. Apply writes a
same-directory temporary file, revalidates parent identity and prior bytes,
then atomically renames it. Existing unmanaged or drifted files fail closed.
Repeated install with identical settings is idempotent.

## Non-goals

- No wildcard project authorization.
- No automatic transcript, prompt, hidden-reasoning, or tool-output storage.
- No remote ContinuityDB project administration in this release.
- No scanning outside explicitly trusted workspace roots.
- No automatic deletion of repository memories on uninstall.

## Verification and release

- RED/GREEN tests for atomic project ensuring, duplicate names, containment,
  symlinks, concurrency, and Windows path semantics.
- Generated-plugin contract tests against OpenCode's documented plugin shape,
  including first-task injection, compaction, plan-mode tools, governed capture,
  and project isolation.
- Installer transaction, ownership, drift, migration rollback, directory-budget,
  and uninstall tests.
- Real OpenCode smoke where available plus generated-plugin execution on Linux,
  macOS ARM64, and Windows x64 release jobs.
- Full source, binary, semantic, reproducibility, workflow-validator, audit, and
  package gates.
- Mandatory Astraea PASS on the immutable release candidate before merge/tag.

This is a minor feature release and will ship as `v0.8.0`.
