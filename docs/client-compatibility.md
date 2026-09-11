# Client compatibility

Compatibility claims are evidence-graded. A configuration example is not called
verified until the named client has connected to the exact ContinuityDB transport.

## Evidence grades

- **Tool-call verified:** the named client initialized MCP, discovered tools, and
  invoked a ContinuityDB tool successfully.
- **Transport verified:** the named client initialized the Streamable HTTP or
  stdio transport and fetched `tools/list`; tool execution is separately covered
  by the official MCP SDK integration suite.
- **Contract tested:** the versioned configuration or lifecycle output is checked
  against the client's documented schema and exercised with a local adapter test.
- **Documented only:** an example exists without executable evidence. ContinuityDB
  does not use this label as a compatibility claim.

## Matrix

Evidence captured on 2026-09-11:

| Client | Tested version | MCP transport | Lifecycle adapter | Evidence |
|---|---|---|---|---|
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` 1.30.0 | Authenticated Streamable HTTP and stdio; cross-agent shared-owner transfer, scoped tool lists, calls, session termination and identity-swap denial | N/A | **Tool-call verified** |
| Codex CLI | 0.147.0 | Authenticated Streamable HTTP initialization and `tools/list` | Project `AGENTS.md` workflow; Codex has no ContinuityDB-specific native hook here | **Transport verified** |
| GitHub Copilot cloud agent / code review | Official repository MCP JSON contract current on 2026-09-11 | Remote HTTP with explicit three-tool allowlist; all listed tools carry `readOnlyHint: true` | None | **Contract tested**; real GitHub-hosted run pending |
| Claude Code | Official MCP and hook contracts current on 2026-09-11 | Remote HTTP configuration | `SessionStart` emits `hookSpecificOutput.additionalContext`; `Stop` saves only an explicit structured file | **Contract tested**; binary unavailable on the test VM |
| OpenCode | Official MCP/plugin contracts current on 2026-09-11 | Remote MCP configuration | Compaction context injection and explicit idle checkpoint adapter | **Contract tested**; binary unavailable on the test VM |
| Cursor | Existing stdio/HTTP-backed MCP configuration | stdio thin adapter | `sessionStart` and `stop` command shape | **Contract tested**; real client run pending |

The Codex transport probe deliberately stops after tool discovery because the
standalone Codex CLI on the test VM has no model API authentication. That is not
reported as a model/tool-call proof. Run `npm run test:codex-client` on an
installed Codex host to reproduce transport discovery. The SDK suite remains the
deterministic tool-call and cross-client data-path proof.

## Security profiles

Tool visibility comes from the authenticated identity's scopes:

| Token scopes | Exposed MCP tools |
|---|---|
| `memory:read` | `memory_search`, `memory_context_pack`, `handoff_latest` |
| `memory:capture` | `memory_capture`, `handoff_checkpoint` |
| `memory:feedback` | `memory_feedback` |

Read-only tools declare `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, and `openWorldHint: false`. Write tools declare
`readOnlyHint: false`. For Copilot's shared repository configuration, use a
read-only token and the explicit three-tool allowlist because GitHub-hosted
agents can invoke enabled tools autonomously.

Each stateful HTTP MCP session is bound to the normalized tenant, principal,
owner, agent, scopes, project allowlist, and sensitivity allowlist from the
credential that initialized it. Reusing that session ID with another credential
returns HTTP 403. Sessions are random, capacity-bounded (including concurrent
pending initializations), actively idle-expiring without requiring later
traffic, and can be explicitly terminated with MCP `DELETE`. Endpoint shutdown
rejects new initialization and waits for already-started initialization paths to
settle before closing the vault.

## Reproducing

```bash
npm run validate:clients
npm run test:clients
npm run test:codex-client # requires the Codex CLI; transport discovery only
```

Client examples are in [`examples/clients`](../examples/clients). Never replace
the credential placeholders with literal tokens in repository files. Use each
client's environment/secret facility.

## Official contracts used

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [GitHub repository MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
