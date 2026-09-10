# Benchmarks

ContinuityDB publishes reproducible performance, quality, isolation and failure
results. A fast local run is not evidence for distributed or billion-record
scale.

## Embedded mixed workload

```bash
npm run benchmark:scale -- \
  --records=10000 \
  --queries=500 \
  --operations=500 \
  --repetitions=3 \
  --concurrency=1,8,32 \
  --progress-every=10000 \
  --output=benchmarks/results/embedded-10k.json
```

The benchmark creates a deterministic synthetic multi-tenant corpus, measures
canonical ingestion and direct retrieval, then drives the HTTP service with a
75% search, 15% context-pack and 10% automatic-capture workload. It reports all
individual runs as well as medians, tail latency, failures, isolation violations,
storage and process memory.

Long corpus builds emit cumulative ingestion progress to stderr so nonlinear
degradation is visible before a scale rung consumes hours.

The service rate limiter is deliberately bypassed for this capacity test. Rate
limit behavior remains covered by security tests and must be benchmarked as a
separate quota-policy profile.

## Quality

```bash
npm run benchmark:quality
```

For hybrid quality, configure a supported embedding provider and run:

```bash
npm run benchmark:hybrid
```

Never publish a scale claim without the hardware details, raw per-run output,
dataset generator, index configuration and error/isolation counts.
