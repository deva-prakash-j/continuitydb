# Context Vault pre-build research

Date: 2026-09-09
Decision: **Conditional Go**

## Product thesis

Context Vault is a local-first, provider-neutral engineering memory service. Its
first job is narrow: preserve Git-grounded decisions and dependency knowledge
across repositories, sessions, IDEs, and model providers, then return a small,
cited context pack for the current coding task.

It is not a new vector database and it is not passive desktop surveillance.

## Initial customer and painful job

- **ICP:** senior engineers working across multiple dependent repositories while
  using two or more AI coding clients.
- **Painful job:** avoid repeatedly reconstructing architecture, prior decisions,
  build commands, and change impact whenever the repo, session, or provider changes.
- **Measurable ROI:** minutes saved per context rebuild, fewer missed dependent
  changes, and fewer stale suggestions.
- **Initial platform:** local daemon on a developer workstation, exposed through
  MCP and a versioned REST API.
- **Geography:** product design is geography-neutral. Employer policy and data
  residency remain deployment gates.

## Evidence

GitHub Copilot Memory validates that persistent coding memory is an active user
need. It stores repository facts and user preferences, cites repository facts,
and revalidates them against the current branch. However, repository facts can
only be used in the same repository and unused memories expire after 28 days.
It is also provider-bound. [GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)

GitHub documents that arbitrary MCP servers can be configured manually in VS
Code and made available across workspaces through personal settings. Enterprise
or organization policy can disable MCP, so an office rollout cannot be assumed.
[GitHub Copilot MCP](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp)

Existing competitors prove demand but narrow the opportunity:

| Product | Current positioning | Gap relevant to this MVP |
|---|---|---|
| [Mem0](https://docs.mem0.ai/platform/mem0-mcp.md) | Portable CRUD/search memory over MCP; coding-client integrations | Generic memory; no first-class Git-grounded multi-repo dependency/change-impact model |
| [Pieces](https://pieces.app/pricing.md) | Cross-tool, on-device work timeline and MCP memory | Broad activity capture rather than an inspectable branch/commit-valid engineering graph |
| [Zep](https://help.getzep.com/concepts.md) | Temporal context graph with provenance and invalidation | Infrastructure rather than a packaged multi-repo developer workflow |
| [Graphiti](https://github.com/getzep/graphiti) | Open temporal graph building block | Requires product, governance, and developer integration layers |
| [Letta](https://github.com/letta-ai/letta-code) | Stateful agent runtime and portable agent memory | Centered on the Letta harness rather than a neutral engineering record |
| [Continue](https://github.com/continuedev/continue/blob/main/docs/customize/rules.mdx) | Versioned rules, context selection, and MCP | Rules are explicit instructions, not governed cross-session memory |

Official pricing checked on 2026-09-09 gives market anchors near $19-20/month
for individual paid memory/stateful-agent products: Mem0 Starter is $19/month,
Pieces Pro is $18.99/month, and Letta Pro is $20/month. These are vendor prices,
not evidence that users will pay for this specific product.

## What is proven and unproven

**Proven**

- Persistent coding memory is now a first-party Copilot feature.
- Provider-neutral context delivery through MCP is technically feasible.
- Multiple vendors monetize persistent memory around the $19-20/month range.
- Same-repository memory does not solve dependent repository changes.

**Unproven**

- Willingness to pay specifically for cross-repository continuity.
- Whether employers will permit local indexing or external MCP configuration.
- Recall quality on real dependent-change tasks.
- Reliable automatic capture in closed clients; MCP is transport, not lifecycle.

## MVP boundary

Build:

- policy-controlled automatic capture plus separately authorized approval for durable/global writes;
- personal, organization, project, repository, and dependency scopes;
- Git commit/path/symbol citations and validity metadata;
- FTS5 lexical retrieval first, with a replaceable vector index later;
- dependency links and token-budgeted context packs;
- local MCP stdio connector and deterministic export;
- correction, tombstoning, audit metadata, and complete index rebuild.

Defer:

- passive screen/clipboard capture;
- automatic raw-chat ingestion;
- cloud sync and team tenancy;
- a novel vector database;
- autonomous memory promotion;
- employer-code ingestion without an explicit organizational policy gate.

## Economics (estimates, not vendor quotes)

For one local user, SQLite/FTS5 has no metered infrastructure cost. A local
embedding model would also have no API fee, with the tradeoff of local CPU/RAM.
A small optional hosted control plane is estimated at $5-15/month before support,
monitoring, backups, and acquisition. At $15-25/user/month, support and secure
enterprise integration—not storage—will dominate unit economics.

Stress case: automatic code chunking and remote embeddings can turn every repo
change into inference spend and privacy exposure. It is excluded until benchmarks
show lexical plus structured retrieval is insufficient.

## Pre-build gates

1. Interview 12-15 senior developers; at least 8 must lose 30+ minutes per week
   rebuilding cross-session or cross-project context.
2. Find five design partners who can legally run a local MCP connector.
3. Obtain three paid-pilot commitments around $15-25/user/month or an organization pilot.
4. On 20+ grounded tasks, reach at least 90% grounded-memory accuracy, 85% useful
   top-k recall, under 2% stale-memory false positives, and p95 below 500 ms.
5. Prove the same vault in at least two different clients/providers.
6. Return zero unauthorized results in adversarial scope-isolation tests.

## Strongest evidence against proceeding

Pieces already sells cross-tool memory, Mem0 already offers MCP memory and coding
plugins, and Copilot Memory is bundled into the incumbent product. The project is
only defensible if it stays focused on Git-grounded multi-repo dependency
continuity and enterprise-safe portability.

## Recommendation

Proceed with a local prototype and benchmark, not a commercial build. The next
decision is based on retrieval quality, client portability, and customer
interviews—not feature count.
