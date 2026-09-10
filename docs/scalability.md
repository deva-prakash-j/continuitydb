# Scalability model

ContinuityDB has one API/data contract and three deployment envelopes. “Supports
billions” is not a property of an interface or a diagram; it requires a sharding
plan, bounded fan-out, failure recovery, and published load evidence.

## Envelopes

| Mode | Intended scale | Storage/query path | Status |
|---|---:|---|---|
| Embedded | one developer, tens of agents, up to ~250k curated records | SQLite WAL + FTS5 + bounded local vector scan | implemented and tested |
| Team | hundreds of agents, up to tens of millions of records | PostgreSQL/pgvector, replicas, queue workers, object storage | reference schema supplied; runtime adapter pending |
| Distributed | 10–20k+ agents, hundreds of millions to billions of records | tenant router, partitioned event store, object storage, Kafka-compatible log, OpenSearch/Vespa, Qdrant/Milvus, graph adjacency service | architecture target; not benchmark-proven |

The embedded semantic scan deliberately caps work at 250k vectors. It never
pretends to be an ANN database. A production adapter must implement the same
filter-first contract in the vector engine.

## Distributed topology

```text
Clients / agents
      |
OIDC or mTLS gateway -- quotas, request limits, tenant routing
      |
Stateless Query API --------------------------+
      |                                       |
      +-- metadata/ACL snapshot cache         |
      +-- lexical index shards                |
      +-- vector index shards                 |
      +-- graph adjacency shards              |
      |                                       |
      +-------- RRF + rerank + pack ---------+

Ingest API -> durable log -> normalize/chunk -> canonical event/object store
                          -> lexical projector
                          -> embedding projector
                          -> graph projector
                          -> validity/staleness projector
```

## Mandatory invariants

1. Route by `tenant_id`; a query may fan out only across partitions assigned to
   that tenant or its explicit organization federation.
2. Apply tenant, principal, project, sensitivity, status and temporal filters in
   every backend before candidate text leaves the backend.
3. Canonical writes commit once. Indexes update through an outbox/log and may be
   replayed idempotently.
4. Every projection carries canonical content hash and embedding/index version.
   A hash mismatch makes the candidate ineligible.
5. Query fan-out, graph depth, candidates per signal, reranker input and token
   output are all hard-bounded.
6. Deletion writes a tombstone first and propagates a purge event to every
   projection, cache and object copy. Compliance status is observable.
7. No global “search all tenants” path exists in the data plane.

## Partition and index strategy

- **Routing key:** stable hash of `tenant_id`; very large tenants may opt into
  project sub-shards through a routing manifest.
- **Canonical metadata/events:** PostgreSQL-compatible partitions for team mode;
  distributed SQL or explicitly sharded PostgreSQL at global scale.
- **Bodies:** small records inline, large immutable bodies in encrypted object
  storage addressed by SHA-256.
- **Lexical:** FTS5 locally; OpenSearch/Vespa/Elasticsearch in distributed mode.
- **Vector:** exact/bounded scan locally; pgvector for team mode; a sharded ANN
  engine for billion-scale mode. Filter cardinality and recall must be measured.
- **Graph:** relational adjacency tables first. Move hot high-degree adjacency to
  a dedicated graph/KV service only after traversal profiles justify it.
- **Caching:** cache only post-ACL IDs/scores, keyed by tenant, principal policy
  revision, project closure, query hash and index generation.

## Backpressure and overload

- Interactive search and ingestion have separate pools and quotas.
- Agent capture is idempotent and separately quota-controlled by tenant, owner,
  originating agent and project; approval/admin capacity is isolated from capture.
- Database sessions set both `continuity.tenant_id` and `continuity.owner_id` so
  PostgreSQL row-level security remains a backstop when an adapter filter regresses.
- The ingest log absorbs bursts; workers use leases, capped retries and a dead
  letter state.
- Expensive reranking is shed before lexical/vector retrieval.
- Queries fail closed on policy/index-generation mismatch.
- Per-tenant circuit breakers prevent one tenant or runaway agent from exhausting
  shared resources.

## Scale gates before any claim

Publish the hardware, dataset generator, index settings and full percentile
output for each gate:

| Gate | Target |
|---|---|
| Concurrent clients | 20,000 simulated agents with realistic think time |
| Corpus | at least 1 billion metadata rows and vectors, not extrapolated from 10k |
| Search | p95 < 300 ms and p99 < 750 ms at target concurrency |
| Context pack | p95 < 500 ms before optional remote cross-encoder |
| Freshness | committed change visible to all projections in p99 < 10 s |
| Availability | survive one query node and one shard replica loss |
| Isolation | zero unauthorized IDs/text in adversarial multi-tenant tests |
| Retrieval quality | hybrid nDCG@10 beats lexical-only and vector-only on grounded tasks |
| Cost | report storage, ingest and 1k-query cost per million memories |

Until those gates run on a distributed adapter, the repository must say
“designed for horizontal scale,” not “billion-scale proven.”

## Reproducible benchmark ladder

Run `npm run benchmark:scale` at 10k, 100k, 250k and 1M records to locate the
embedded-mode ceiling. Use at least three repetitions and publish raw runs; do
not report only the best result. The benchmark mixes reads, context packing and
automatic agent capture, records tail latency and checks tenant isolation.

The next ladder requires the production PostgreSQL/pgvector adapter:

1. 10M records and 100-1,000 clients for the team envelope.
2. 100M records with routed shards, replicas and projection workers.
3. One billion real metadata rows and vectors with 20,000 clients, realistic
   think time, skewed tenants and injected node/shard failures.

At every rung, run retrieval quality and adversarial isolation suites alongside
load. Latency without correct, authorized results is a failed benchmark.
