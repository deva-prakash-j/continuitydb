import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HybridEngine } from "../src/embeddings.js";
import { ContextVault, estimateSerializedTokens } from "../src/store.js";

test("final detailed-search envelopes respect budgets after fallback metadata is applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-final-search-budget-"));
  const vault = new ContextVault(root);
  try {
    const record = vault.commit(vault.propose({
      title: "Searchable budget evidence",
      body: "Synthetic searchable evidence — தமிழ் ✨. ".repeat(100),
    }).record.id);
    const embedder = {
      id: "fixture:budget",
      async embedQuery() { return [1, 0, 0, 0, 0, 0, 0, 0]; },
    };
    vault.putEmbedding(record.id, [1, 0, 0, 0, 0, 0, 0, 0], embedder.id);
    for (const provider of [null, embedder]) {
      const engine = new HybridEngine(vault, provider);
      for (const mode of ["graph-first", "hybrid", "graph-only"]) {
        for (const budget of [64, 128, 200, 300, 475, 1200]) {
          const result = await engine.searchDetailed({
            query: "searchable", retrieval_mode: mode, token_budget: budget,
          });
          assert.ok(estimateSerializedTokens(result) <= budget,
            `${mode}/${Boolean(provider)} response exceeds ${budget}: ${JSON.stringify(result)}`);
          assert.equal(result.retrieval.requested_mode, mode);
          if (mode === "graph-first") {
            assert.equal(result.retrieval.semantic_fallback_used, Boolean(provider));
            assert.equal(result.retrieval.effective_mode, provider ? "hybrid" : "lexical+graph");
            if (!provider) assert.equal(result.retrieval.fallback_reason, "semantic_unavailable");
          }
          if (mode !== "graph-only" && budget >= 300) {
            assert.equal(result.results.length, 1, "refitting must retain fitting cited evidence");
            assert.equal(result.results[0].id, record.id);
            assert.ok(result.results[0].body.length > 0);
          }
        }
      }
    }
    assert.equal(vault.get(record.id).body, record.body, "response packing must not mutate stored text");
  } finally {
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
