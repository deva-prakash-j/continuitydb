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

The built-in local model has dedicated quality and performance commands:

```bash
# First run downloads and verifies the pinned 34.2 MB artifacts.
npm run benchmark:local

# Cache first, then set CONTINUITYDB_LOCAL_MODEL_OFFLINE=true for closed-network runs.
npm run benchmark:local:performance -- --repetitions=10
```

Publish model ID, revision, dimensions, query/document encoding behavior,
quality metrics, latency, throughput, RSS, runtime version, and hardware. The
repository's small 14-query fixture is a deterministic regression gate rather
than a substitute for a held-out engineering retrieval dataset.

## Native graph-first ablation

```bash
npm run benchmark:graph-first
```

This dependency-free benchmark creates five disposable Git repositories and
builds their graph generations through production committed-snapshot extraction
into one temporary vault. It uses the same records and active generations for
all 30 frozen questions, then runs `graph-only`, `graph-first`, and `hybrid` at
`top_k=5`. The fixture spans exact symbols, call
paths, dependency impact, configuration flow, authorized cross-project paths,
conceptual questions, and historical decisions. Six questions are negative
isolation probes.

The JSON report includes overall and per-class recall, required citation-path
coverage, p50/p95 latency, median/p95 serialized context tokens, embedding
invocations and avoidance, stale-generation failures, cross-scope/owner/
sensitivity/branch/history/expected-empty probes, a production cross-generation
path, index and incremental-update time, sampled peak RSS, SQLite size, and
incremental parsed/reused file counts.
The included deterministic benchmark embedder is an instrumentation fixture, not
a quality claim for a production embedding model. Latencies are real wall-clock
measurements and therefore vary by machine. Token measurement canonicalizes
volatile timestamps, scores, and self-measurement fields; fixture order, corpus,
report schema, and all non-timing calculations are deterministic. Pass
`--output=PATH` to also write the report to a file. Pass
`--promote-default=graph-first` only to check a
proposed promotion: it exits non-zero unless every release gate passes. This
never changes the runtime default.

The runner recommends `graph-first` only when every release gate passes. It does
not invoke a downstream answer model, so `answer_accuracy` is reported as `null`
and the answer-accuracy gate remains failed. `hybrid` therefore remains the
runtime default until a separate held-out, evidence-backed evaluation supplies
that missing result and all other gates pass.

Never publish a scale claim without the hardware details, raw per-run output,
dataset generator, index configuration and error/isolation counts.
