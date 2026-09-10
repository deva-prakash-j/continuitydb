import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { LocalOnnxEmbedder } from "../src/local-embeddings.js";

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

const repetitions = Math.max(3, Math.min(100, Number(process.argv.find((item) => item.startsWith("--repetitions="))?.split("=")[1] || 10)));
const embedder = new LocalOnnxEmbedder({
  home: process.env.CONTINUITYDB_HOME,
  cacheDir: process.env.CONTINUITYDB_MODEL_CACHE,
  offline: process.env.CONTINUITYDB_LOCAL_MODEL_OFFLINE === "true",
  threads: process.env.CONTINUITYDB_LOCAL_MODEL_THREADS,
  batchSize: process.env.CONTINUITYDB_LOCAL_MODEL_BATCH_SIZE,
});

const started = performance.now();
const model = await embedder.ready();
const initializationMs = performance.now() - started;
await embedder.embedQuery("warm the local embedding runtime");

const scenarios = [];
for (const batchSize of [1, 8, 32]) {
  const durations = [];
  const texts = Array.from({ length: batchSize }, (_, index) => (
    `Engineering memory ${index}: publish the schema before regenerating downstream API clients.`
  ));
  for (let run = 0; run < repetitions; run += 1) {
    const before = performance.now();
    await embedder.embedDocuments(texts);
    durations.push(performance.now() - before);
  }
  const totalSeconds = durations.reduce((sum, value) => sum + value, 0) / 1000;
  scenarios.push({
    batch_size: batchSize,
    repetitions,
    p50_ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95_ms: Number(percentile(durations, 0.95).toFixed(3)),
    texts_per_second: Number(((batchSize * repetitions) / totalSeconds).toFixed(2)),
  });
}

const memory = process.memoryUsage();
process.stdout.write(`${JSON.stringify({
  benchmark: "continuitydb-local-embedding",
  model_id: embedder.id,
  model_download_bytes: model.download_bytes,
  dimensions: model.dimensions,
  initialization_ms_from_verified_cache: Number(initializationMs.toFixed(3)),
  runtime: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model || "unknown",
    logical_cpus: cpus().length,
    rss_mb: Number((memory.rss / 1024 / 1024).toFixed(2)),
  },
  scenarios,
}, null, 2)}\n`);
