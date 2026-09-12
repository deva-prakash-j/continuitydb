# ContinuityDB Zero-Instruction Agent Integration Design

**Date:** 2026-09-12  
**Status:** Proposed for implementation  
**Target:** ContinuityDB v0.7.0  
**Supported clients:** Codex, Claude Code, OpenCode, Cursor, VS Code Copilot

## 1. Goal

After a project is registered and a supported client is connected with
`continuitydb setup --apply`, the client should use ContinuityDB without the
user repeatedly prompting it to do so.

The integration must:

1. make bounded, project-scoped recall part of the client's normal startup or
   first-task behavior;
2. use `memory_capture` only when the user explicitly asks to remember or save
   a durable fact;
3. keep project identity server-controlled and fail closed for missing or
   unregistered project IDs;
4. preserve existing client configuration and instruction files atomically;
5. report exactly which behavior is host-enforced and which is instruction-led.

## 2. Non-goals and safety boundary

The integration will **not**:

- capture every prompt, transcript, tool result, hidden reasoning, or session;
- infer durable memory from ordinary conversation;
- bypass a genuine read-only, plan, sandbox, or approval policy;
- mark a denied or unavailable capture as saved;
- use a wildcard project allowlist or implicit `default` project;
- treat recalled memory as authorization or trusted instructions;
- promise native startup hooks where the client does not provide them.

If an explicit capture is blocked by the client policy, the agent must say that
the memory was not saved. It may present a proposed compact memory for later
capture, but it must not persist it through another channel.

## 3. Chosen architecture

Use one provider-neutral ContinuityDB policy and five native client adapters.
Do not build five independent memory implementations.

Each adapter installs two layers where the client supports them:

1. **MCP transport:** project-scoped ContinuityDB tools and server instructions.
2. **Lifecycle/policy asset:** automatic startup context injection when native
   hooks exist; otherwise an always-loaded managed project instruction tells the
   client to retrieve context before its first substantive task action.

This is preferable to MCP-only integration, which exposes tools but cannot
ensure they are used, and to a transparent prompt proxy, which would require raw
conversation interception and weaken client security boundaries.

## 4. Shared behavior contract

### 4.1 Recall

At session start, resume, compaction, or the first substantive task action:

1. use the configured registered `project_id`;
2. obtain the current branch when available;
3. call `handoff_latest` only when a stable task ID exists;
4. call `memory_context_pack` with the current task, a bounded token budget, and
   the configured dependency depth;
5. inject only the returned bounded pack;
6. label recalled material as untrusted evidence and verify repository
   citations before relying on it.

Recall failure is non-destructive. The client continues without memory and
surfaces one concise warning. It does not silently broaden project scope.

### 4.2 Governed capture

Capture is allowed only when the user explicitly asks to remember, save, record,
or update a durable fact. The adapter instructs the agent to submit a compact,
structured claim through `memory_capture`; server-side policy, sensitivity,
idempotency, duplicate, and conflict checks remain authoritative.

The adapter never sends the full user prompt. The proposed body must contain
only the durable fact needed for future work. Credentials, secrets, raw logs,
temporary task state, and hidden reasoning are forbidden.

If write tools are unavailable or denied, the adapter reports `not saved`.
There is no cross-mode write bypass.

### 4.3 Handoffs

Automatic stop/idle handling may save only an explicit structured handoff file
created for that purpose. It may not mine a transcript to manufacture a
checkpoint.

## 5. Client adapter matrix

| Client | MCP asset | Automatic recall asset | Capture behavior | Truthful capability label |
|---|---|---|---|---|
| Codex | `.codex/config.toml` managed MCP block | Managed block in repository `AGENTS.md`, loaded once per run/session | Explicit user intent triggers governed MCP capture when writes are allowed | `policy-led` |
| Claude Code | `.mcp.json` | Managed `.claude/settings.json` `SessionStart`/resume/compact hook plus concise managed `CLAUDE.md` policy | Governed MCP capture on explicit intent; structured stop checkpoint only | `hook-enforced` |
| OpenCode | `opencode.json` | Managed `.opencode/plugins/continuitydb.js` for compaction/idle plus a managed `AGENTS.md` block for first-task recall | Governed MCP capture on explicit intent; explicit handoff file only | `plugin+policy` |
| Cursor | `.cursor/mcp.json` | Managed `.cursor/hooks.json` `sessionStart` hook plus `.cursor/rules/continuitydb.mdc` fallback for cloud/read-only startup gaps | Governed MCP capture on explicit intent | `hook+policy` |
| VS Code Copilot | `.vscode/mcp.json` | Managed block in `.github/copilot-instructions.md` | Governed MCP capture on explicit intent when the client permits writes | `policy-led` |

The setup result must not call a policy-led integration a native hook. Cursor
cloud sessions that begin read-only must be reported as policy fallback until
hooks become available.

## 6. Installation and update UX

`continuitydb setup --agents detected --project-dir <repo> --apply` installs the
complete managed integration for detected clients. `--agents all` generates all
five supported adapters. `agents connect <client> --apply` installs the same
complete adapter for one client.

Add an explicit `--mcp-only` escape hatch for users who want tool exposure
without lifecycle/policy assets. The default is the complete integration because
the user requested no repeated prompt instructions.

Preview and apply output include, per client:

- MCP configuration path;
- lifecycle/policy paths;
- `recall_mode` (`hook-enforced`, `plugin-enforced`, `hook+policy`, or
  `policy-led`);
- `capture_mode: explicit-governed`;
- selected, planned, applied, and verified states;
- whether a client executable was detected;
- any capability limitation, including read-only write denial.

`agents status` verifies every managed asset independently and reports drift.

## 7. Managed-file semantics

All client assets participate in the existing two-phase connector transaction:

1. resolve and validate the registered project identity once;
2. parse every existing target before the first write;
3. reject symlinked targets and unsafe parent paths;
4. render all MCP, hook, plugin, rule, and instruction changes;
5. use explicit ContinuityDB markers for shared Markdown/TOML files;
6. write each prepared file atomically under canonical per-file locks;
7. roll back the entire client batch if any write fails;
8. preserve unknown keys, comments where the format permits, and unrelated user
   instructions;
9. make reruns idempotent and upgrades replace only the managed section;
10. disconnect removes only ContinuityDB-owned entries and files.

An unmanaged conflicting ContinuityDB entry fails closed with an actionable
error. Setup never silently overwrites it.

## 8. Runtime components

Create one shared policy renderer and adapter descriptors instead of duplicating
policy text across connector branches. Extend the bundled lifecycle hook for
Claude/Cursor output contracts and package the existing OpenCode plugin as a
generated managed asset. Codex and Copilot use compact managed instruction
blocks backed by MCP server instructions.

For local stdio installations, `continuitydb hook session-start` reads the
configured local vault directly; it must not require a separately running HTTP
daemon. For remote installations, the same command uses the configured HTTPS
service and token environment reference. The OpenCode plugin uses the bundled
hook command for local recall and the existing authenticated HTTP client for
remote compaction/handoff operations. Because OpenCode exposes no documented
session-start context injection output, its first-task recall remains an
always-loaded managed policy, while the plugin handles compaction and explicit
structured handoff lifecycle events.

All runtime adapters receive project identity from generated server-controlled
configuration. They must not derive or accept a different `project_id` from a
model-generated prompt.

## 9. Testing strategy

Development follows RED-GREEN-REFACTOR.

### 9.1 Contract tests

- exact managed assets for all five clients;
- native hook/plugin schemas match current official client contracts;
- Codex project instruction and MCP configuration load in a real CLI probe;
- Copilot instructions use the documented repository-wide file;
- capability labels match actual enforcement.

### 9.2 Behavioral tests

- a fresh client session receives or requests the correct project-scoped pack
  without a user saying “use ContinuityDB”;
- local hook recall works with no HTTP daemon, while remote hook recall uses only
  the configured HTTPS endpoint and token reference;
- a second registered project cannot read or write the first project;
- explicit remember/save captures one compact fact;
- ordinary prompts, transcript text, tool logs, and secrets are not captured;
- denied/read-only capture produces `not saved` and no searchable record;
- missing or unregistered project IDs fail closed with no `default` fallback;
- handoff hooks accept only the explicit structured checkpoint file.

### 9.3 Transaction and packaging tests

- preview performs no writes;
- apply, upgrade, disconnect, and rerun are atomic and idempotent;
- an injected failure at every client-asset write restores the exact prior tree;
- symlink and path-race probes fail closed;
- packaged standalone binaries generate the same integrations as source;
- Linux x64, macOS arm64, and Windows x64 native matrices validate generated
  assets; Intel macOS remains npm-only while the upstream SEA issue persists.

### 9.4 Independent review

Every task receives an independent code review. The final immutable branch must
receive Astraea `PASS` with no P0/P1 findings before merge or release.

## 10. Documentation and release

Update README onboarding, client compatibility, security/privacy boundaries,
and generated examples. Documentation must distinguish host-enforced hooks from
instruction-led behavior and state that read-only capture is not bypassed.

After exact-head local, packaged-binary, native CI, artifact checksum, and
provenance gates pass, merge through a pull request and publish the audited
stable `v0.7.0` tag. Verify all six supported binary/checksum assets and their
attestations after publication.

## 11. Acceptance criteria

The feature is complete only when:

1. one setup command installs a truthful complete adapter for each selected
   supported client;
2. each client performs project-scoped recall through a native hook/plugin or an
   always-loaded managed policy without repeated user instructions;
3. only explicit durable-memory intent can trigger capture;
4. no raw-context auto-capture or read-only bypass exists;
5. every generated project ID is registered, generic, and fail-closed;
6. all managed assets are transactional, reversible, and drift-verifiable;
7. the full source, packaged binary, cross-platform, and adversarial suites pass;
8. Astraea returns `PASS` for the exact release candidate;
9. the merged commit and stable `v0.7.0` release are independently verified.

## 12. Client contract references

- Codex project instructions and MCP: <https://learn.chatgpt.com/docs/agent-configuration/agents-md> and <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>
- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Cursor hooks: <https://cursor.com/docs/hooks>
- OpenCode plugins: <https://opencode.ai/docs/plugins/>
- GitHub Copilot repository instructions: <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions>
