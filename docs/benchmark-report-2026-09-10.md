# Embedded mixed-workload benchmark — 2026-09-10

This is ContinuityDB's first repeated mixed read/write HTTP benchmark. It tests
the embedded SQLite/FTS5 deployment envelope and must not be presented as a
distributed or billion-record result.

## Reproduction

Base revision: `e5f807a52b8becacd62d12f2c9e54ccbcb102f7f`, plus the benchmark harness in
the commit containing this report.

```bash
node benchmarks/scale-benchmark.js \
  --records=10000 \
  --queries=500 \
  --operations=600 \
  --repetitions=3 \
  --concurrency=1,8,32 \
  --warmup=50 \
  --output=benchmarks/results/embedded-10k-2026-09-10.json
```

Machine: 8 logical Intel Xeon Silver 4416+ CPUs, 16 GB RAM, Linux 6.8,
Node.js 25.9.0. The rate limiter was bypassed to measure service capacity; ACL
filters and capture policy remained active.

The deterministic corpus contained 10,000 Git-grounded synthetic memories over
four tenants and 50 projects. HTTP traffic was 75% search, 15% context-pack and
10% policy-controlled automatic working-memory capture.

## Results

| Metric | Result |
|---|---:|
| Median canonical ingest | 161.44 records/s |
| Median direct search p95 | 6.334 ms |
| Worst direct search p99 | 7.895 ms |
| Retrieval misses | 0 |
| Tenant isolation violations | 0 |
| HTTP failures | 0 |
| Approximate storage after workload | 36.5 MB/run |

| Concurrent clients | Throughput ops/s | Search p95 | Context-pack p95 | Capture p95 |
|---:|---:|---:|---:|---:|
| 1 | 132.96 | 8.554 ms | 9.112 ms | 16.405 ms |
| 8 | 135.31 | 71.330 ms | 75.257 ms | 76.447 ms |
| 32 | 128.34 | 284.101 ms | 506.872 ms | 743.367 ms |

Values are medians across three full corpus runs, except the explicitly labelled
worst p99. Raw per-run percentiles, memory and storage are in
[`benchmarks/results/embedded-10k-2026-09-10.json`](../benchmarks/results/embedded-10k-2026-09-10.json).

## Verdict

The embedded engine is fast for low-concurrency local-agent use and preserves
correctness under this test. Throughput does not increase with HTTP concurrency,
while tail latency grows sharply. The synchronous SQLite query path, canonical
Markdown writes and audit appends share one Node.js event loop and form the
current saturation boundary.

At 32 clients, search remains just inside the future distributed search p95
target of 300 ms, while context packing misses its 500 ms target and capture
tail latency is unsuitable for a high-concurrency service. Horizontal scale
work should therefore proceed through the PostgreSQL/outbox worker adapter,
stateless query replicas and backend-specific indexes rather than attempting to
stretch the embedded process.

## Next gates

1. Repeat embedded runs at 100k and 250k records to locate the local corpus
   ceiling and profile CPU, filesystem and FTS time separately.
2. Implement the PostgreSQL/pgvector runtime adapter and bulk generator, then
   run 10M records with 100-1,000 clients.
3. Add projection-freshness, duplicate-event and injected-failure scenarios.
4. Expand quality evaluation to grounded semantic, stale/conflict and graph
   impact queries before any 100M or one-billion-record run.
