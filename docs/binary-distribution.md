# Standalone binary distribution and agent setup

ContinuityDB 0.7 can be bundled as a native single executable. End users do
not need Node.js, npm, a global package installation, or a separate SQLite
library.

## Artifact contents

The executable contains:

- a Node.js runtime with built-in SQLite/FTS5;
- the ContinuityDB CLI, HTTP service, MCP servers, policy engine, and adapters;
- the MCP SDK and JWT verification dependencies;
- the ONNX Runtime WebAssembly glue and integrity-pinned WASM binary.

The 34.2 MB BGE-small model and vocabulary remain an integrity-pinned first-use
download. This keeps the executable smaller and lets lexical/graph-only users
avoid model storage. `setup --semantic` downloads the model, validates exact
byte sizes and SHA-256 digests, and stores it in a private cache.

## Supported build targets

| Target | Release workflow | Evidence before first v0.7 release |
|---|---:|---|
| Linux x64 | Yes | Native functional + semantic CI green at `e0dcf16` |
| macOS arm64 | Yes | Post-sign functional + semantic CI green at `e0dcf16` |
| Windows x64 | Yes | Native functional + semantic CI green at `e0dcf16` |

Intel macOS is intentionally not a release target. Node 25 Single Executable
Applications [segfault on x64 macOS](https://github.com/nodejs/node/issues/62893),
including a minimal upstream reproduction. ContinuityDB will not publish an
artifact that fails before application startup; Intel users must use the npm
distribution until Node provides a verified SEA runtime for that platform.

Do not describe an artifact as verified until its native build and binary smoke
job is terminal green. macOS outputs receive ad-hoc signing in CI; official
Developer ID and Windows Authenticode signing require project-owned signing
identities and are not currently configured.

## Build and smoke test

Binary construction uses Node's official Single Executable Application
facility. Build hosts and the complete `npm run release:check` gate require
Node 25.5 or newer because the gate builds and exercises the standalone
binary from a clean tree. Produced binaries include
their runtime and have no Node requirement on the destination host.

```bash
npm ci --ignore-scripts
npm run test:binary
npm run test:binary:reproducible
npm run checksum:binaries
```

SEA construction stages the bundle, embedded WASM asset, configuration, and
intermediate executable at a checkout-independent path. The reproducibility
gate archives the exact `HEAD` into two separate clean directories, installs
the locked dependencies in each, builds both Linux executables, and requires
their byte counts and SHA-256 digests to match.

The smoke test proves:

1. the executable identifies itself as standalone;
2. versioned self-install and launcher execution;
3. setup preview and idempotent apply;
4. all five agent configuration writers;
5. vault initialization and doctor checks;
6. foreground HTTP service readiness and clean shutdown;
7. MCP initialization and six-tool discovery;
8. agent capture followed by retrieval.

Use `npm run test:binary:semantic` for the networked model pull plus real local
WASM inference gate.

Pull requests, pushes to `main`, and tagged-release automation apply the same
gates on every supported native matrix target. Every successful `main` push
creates or refreshes one commit-bound GitHub prerelease named
`main-<full-commit-sha>`. A workflow rerun updates that same prerelease only
after confirming its target commit and prerelease state
instead of creating a duplicate. A pushed `v*` tag creates the stable release
for that tag.
For macOS, signing happens before both the ordinary binary smoke and semantic
inference smoke. Checksums and artifact upload happen only after those blocking
tests pass; publication depends on the complete native matrix. Before
publication, the workflow requires all three supported binaries and their
SHA-256 sidecars, verifies each checksum, creates build-provenance attestations,
and then downloads the published assets into a clean directory. It requires
the exact six-file set, compares released binary digests with the verified
build inputs, checks all three sidecars, and verifies build provenance for each
released binary.

## Install

Preview first:

```bash
./continuitydb-linux-x64 install
```

Apply:

```bash
./continuitydb-linux-x64 install --apply
export PATH="$HOME/.local/bin:$PATH"
```

The installer:

- installs to a versioned directory;
- atomically switches a managed launcher;
- refuses symlink traversal in the installation prefix;
- refuses an unmanaged existing launcher unless `--force` is explicit;
- does not edit shell profiles, request administrator access, or send data.

The embedded ONNX WASM bytes are verified and supplied to the inference engine
in memory. ContinuityDB does not extract an executable runtime through a cache
directory, including when cache ancestors are symlinks.

## Set up a project and connect clients

```bash
continuitydb setup \
  --project-dir "$PWD" \
  --owner developer-1 \
  --projects api,schema \
  --agents detected

# Review the JSON plan, then apply the same command with:
continuitydb setup --project-dir "$PWD" --owner developer-1 \
  --projects api,schema --agents detected --apply
```

Use `--agents all` to generate every supported project file even when the
client executable is not installed yet. `agents connect` and `agents
disconnect` accept one client or `all`. All commands preview by default and
need `--apply` to mutate project files.

Multi-client apply is fail-closed. ContinuityDB first parses and validates all
selected files, namespaces, managed markers, paths, and generated output
without writing. It begins the commit phase only after every client passes
preflight. If a later write fails despite preflight, earlier client files and
newly created configuration directories are restored before the command
returns failure.

Local stdio is the default and starts the binary on demand. For one central
service, pass `--transport http --url https://memory.example/mcp`; generated
configs refer to `CONTINUITYDB_MCP_TOKEN` (or `--token-env NAME`) without
copying its value.

## Run

```bash
continuitydb run
```

The default data home is global to the OS user, so every connected repository
uses one vault. Override it with `--home` only when intentionally separating
trust domains. `run` is intentionally foreground-first. Process supervision belongs to the
operator's user service manager, container platform, or orchestrator, which
can provide restart policy, logs, and resource limits without ContinuityDB
inventing an unsafe cross-platform PID daemon.

## Recovery

Changed client files are backed up by content hash below:

```text
<continuitydb-home>/backups/agent-config/<client>/
```

Disconnect removes only the managed ContinuityDB entry or Codex managed block;
unrelated client configuration remains intact. Individual files use atomic
rename. Multi-client operations additionally restore already-written files if
a later commit fails.

Existing JSON client files must contain object-shaped managed namespaces.
Existing Codex TOML must parse cleanly and contain at most one well-formed
ContinuityDB managed block. Connect, disconnect, and status operations fail
closed on malformed structures instead of replacing or reporting success for
an invalid user configuration.

`setup` validates every selected client configuration before initializing a
new vault. Multi-client apply tracks both configuration writes and newly
created immutable backup artifacts; a later failure restores the original
client files and removes backup files/directories created by that failed
batch.

For an existing valid vault, setup inspects SQLite through WAL-aware read-only
mode and never includes `index/` or `records/` in its rollback set. A failed
connector update therefore cannot rewind WAL commits or canonical records made
concurrently after setup began. Incomplete vault initialization and local or
external model-cache changes retain their scoped rollback behavior.

Before upgrading to 0.9.1, stop every writer and back up the full vault directory.
The first writable open adds a canonical-publication outbox; read-only inspection
does not migrate or drain it. Do not run an older writer concurrently, delete the
SQLite file to rebuild search, or restore only record files over an existing vault.
See [0.9.1 recovery notes](releases/v0.9.1.md).

## Release integrity

Each workflow artifact includes a `.sha256` file. Tagged GitHub releases also
use GitHub artifact attestations. Verify both the checksum and release origin
before executing a downloaded binary. Never accept a checksum copied from an
unrelated mirror or chat message.
