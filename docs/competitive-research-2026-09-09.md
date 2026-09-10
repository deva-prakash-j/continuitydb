# Agent memory and code-context landscape

Date: 2026-09-09
Scope: public repositories and first-party product documentation relevant to a
provider-neutral, cross-project agent memory service.

## Method and limits

Repository identity, default branch, activity, and license metadata were checked
through the GitHub repository API on the date above. Feature claims were checked
against each project's current README or linked first-party documentation. Star
counts were intentionally omitted because they are volatile and do not prove
quality. No competitor source code was copied. Names and logos remain their
owners' property.

The research answers a product question, not “which repository should we fork?”
The useful design is a compatible feature synthesis with our own implementation,
data model, security boundary, and engineering-memory specialization.

## Repositories reviewed

| Repository | Branch | License | Relevant strengths | Limitation for our target job |
|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | `main` | Apache-2.0 | user/session/agent memory, extraction, CRUD, hybrid/entity retrieval, SDKs, CLI, self-hosted server | broad personalized memory; advanced hosted behavior does not by itself model Git-grounded cross-repo impact |
| [getzep/graphiti](https://github.com/getzep/graphiti) | `main` | Apache-2.0 | bi-temporal context graph, provenance, incremental updates, hybrid retrieval, graph backends, reranking | graph framework rather than a complete portable developer-memory product |
| [letta-ai/letta](https://github.com/letta-ai/letta) | `main` | Apache-2.0 | editable in-context blocks, archival memory, stateful agents, memory tools, newer context-repository ideas | centered on the Letta agent runtime rather than a neutral cross-client evidence service |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | `main` | Apache-2.0 | ingestion pipelines, graph + vector memory, ontologies, datasets/NodeSets, many storage and agent integrations | general knowledge-memory platform; developer dependency validity is not its narrow product contract |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | `main` | MIT | personalized memory + RAG, contradiction/temporal handling, multimodal ingestion, connectors, APIs and MCP | broad application memory; more infrastructure and connector surface than a focused engineering continuity tool needs initially |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | `main` | MIT | structured schemas, hierarchical namespaces, agent tools, background extraction/consolidation, pluggable stores | SDK coupled to the LangGraph/LangChain ecosystem, not a universal service boundary |
| [CaviraOSS/LongMemory](https://github.com/CaviraOSS/LongMemory) | `main` | Apache-2.0 | temporal/governed lifecycle, recall modes, CLI/HTTP/MCP/UI, session porting, project/code memory, benchmarks | large surface and a different internal model; overlap confirms that governance and portability must be first-class |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | `main` | Apache-2.0 | Tree-sitter symbol extraction, definition/reference graph, PageRank repo map, token-budgeted rendering | a coding-agent context subsystem, not durable cross-provider memory |
| [isink17/codegraph](https://github.com/isink17/codegraph) | `master` | license not asserted by GitHub API at review time | local incremental code graph, symbol/call/impact/test tools, MCP | young code-context implementation; licensing must be clarified before reuse |
| [raultov/knot](https://github.com/raultov/knot) | `master` | MIT | Rust MCP code index combining vector and graph databases, cross-repository intent | young project and infrastructure-heavy for individual local use |

Non-OSS product references were used only to validate demand and integration
expectations: [GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
and [Pieces](https://pieces.app/). Pieces publishes SDKs, CLI, and documentation,
but its core memory service was not treated as an open-source building block.

## Consolidated capability map

| Capability | Why users need it | ContinuityDB v0.3 status |
|---|---|---|
| Explicit remember/search/get/correct/forget | predictable user control | implemented in embedded store; MCP capture/feedback is policy-bounded while approval/admin remain separate |
| User, agent, tenant, session, project scopes | share only the intended context | tenant/owner/agent/project/sensitivity fields and server-bound policies implemented |
| Temporal truth and supersession | answer “what was true then?” without losing history | valid-time filtering, expiry, versions and supersession implemented |
| Provenance and citations | verify rather than trust generated memory | source URI, repo path, symbol, branch and commit returned in every result |
| Lexical retrieval | paths, symbols, hashes and errors | SQLite FTS5/BM25 implemented |
| Semantic retrieval | paraphrases and intent | optional Ollama or OpenAI-compatible embedder plus hybrid fusion implemented; local vectors use bounded scan |
| Knowledge/dependency graph | impact and relationship traversal | project and memory edges, time bounds, graph expansion and graph-score fusion implemented |
| Hybrid fusion and reranking | combine complementary retrieval signals | RRF, freshness/trust/scope boosts and MMR diversity implemented |
| Token-bounded context | avoid filling the model window with duplicates | bounded cited context packs implemented; exact model tokenizer adapters remain open |
| Risk-based capture | automatic transfer without letting a model approve durable/global writes | safe project context auto-activates with TTL; verified Git facts can activate durably; decisions/conflicts are held; MCP cannot approve or delete |
| Idempotent ingestion | safe retries | tenant-scoped idempotency keys implemented |
| Git ingestion | portable repository evidence | tracked-file scanner, change-since-commit mode, symbol/dependency extraction, secret-path denylist implemented |
| Background pipelines | avoid blocking interactive agents | job/outbox schemas implemented; distributed worker runtime is not yet shipped |
| HTTP, MCP, CLI | work across agents and deployment shapes | implemented |
| Tamper evidence and audit | investigate changes and drift | hash-chained local JSONL audit and verification implemented |
| Multimodal ingestion | memory for PDFs/audio/images | deliberately not in engineering-memory core; connector contract is future work |
| Dashboard/editor extension | review and manage memory visually | not implemented; API/CLI are the v0.3 management surface |
| Multi-language AST graph | precise code impact | safe regex symbol baseline implemented; Tree-sitter workers are next |
| Billion-record deployment | stable tail latency at global scale | architecture and PostgreSQL partition schema supplied; not performance-proven and not claimed complete |

## Product decisions

1. **Do not clone every feature.** Passive screen capture, raw chat mining,
   autonomous durable writes, and bundled agent runtimes conflict with the goal
   of a governed neutral evidence layer.
2. **One logical memory, multiple physical indexes.** Canonical records/events are
   authoritative. Lexical, vector, and graph indexes are versioned rebuildable
   projections.
3. **Local and distributed modes share contracts, not databases.** SQLite is the
   simplest private single-user engine. Global scale requires partitioned event
   storage, object storage, queues, and specialized query indexes.
4. **Git validity is the moat.** Every engineering fact should be traceable to a
   commit/branch/path/symbol or explicitly marked as user-authored preference.

## Evidence-based verdict

**Conditional Go remains correct.** The market is crowded for generic “AI
memory.” A public repository is defensible if it remains the best open,
inspectable implementation of cross-repository engineering continuity with
provider-neutral MCP/HTTP delivery, strong tenant boundaries, provenance, and
reproducible retrieval benchmarks.

Still unproven: real-user retention, company-policy acceptance, semantic quality
on large multilingual codebases, and billion-record tail latency. Those are
release gates, not README claims.
