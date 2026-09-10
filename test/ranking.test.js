import assert from "node:assert/strict";
import test from "node:test";
import { maxMarginalRelevance, reciprocalRankFusion, tokenize } from "../src/ranking.js";

test("tokenization splits code identifiers and paths", () => {
  assert.deepEqual(tokenize("ChargeSchema src/main/APIClient.java"), ["charge", "schema", "src", "main", "api", "client", "java"]);
});

test("reciprocal rank fusion rewards agreement across retrievers", () => {
  const result = reciprocalRankFusion([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]]);
  assert.equal(result[0].id, "b");
  assert.ok(result[0].score > result[1].score);
});

test("MMR reduces duplicate context", () => {
  const selected = maxMarginalRelevance([
    { id: "a", title: "Kafka outbox", body: "Kafka outbox relay", score: 1 },
    { id: "b", title: "Kafka outbox", body: "Kafka outbox relay", score: 0.99 },
    { id: "c", title: "Flyway", body: "Database migration", score: 0.8 },
  ], { topK: 2, lambda: 0.5 });
  assert.deepEqual(selected.map((item) => item.id), ["a", "c"]);
});
