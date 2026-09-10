import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEmbedderFromEnv } from "../src/embeddings.js";
import {
  ensureLocalModel,
  localModelStatus,
  LocalOnnxEmbedder,
  normalizeEmbeddingText,
  WordPieceTokenizer,
} from "../src/local-embeddings.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureSpec(name, bytes, expectedHash = hash(bytes)) {
  return {
    id: `fixture:${name}`,
    repository: "fixture/model",
    revision: "a".repeat(40),
    license: "MIT",
    dimensions: 8,
    cache_directory: name,
    artifacts: [{ name: "model.onnx", path: "model.onnx", bytes: bytes.length, sha256: expectedHash }],
  };
}

test("WordPiece tokenizer splits code identifiers and bounds long input", () => {
  const vocabulary = new Map(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "api", "client", "hello", "world"].map((token, index) => [token, index]));
  const tokenizer = new WordPieceTokenizer(vocabulary, { maxTokens: 8 });
  assert.deepEqual(tokenizer.encode("APIClient hello-world"), [2, 4, 5, 6, 7, 3]);
  assert.equal(tokenizer.encode("x".repeat(40_000)).length <= 8, true);
  assert.equal(normalizeEmbeddingText("ChargeAPI_Client/v2"), "charge api client v2");
});

test("local model artifacts use a pinned cache and reject checksum mismatches", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-model-test-"));
  const bytes = Buffer.from("fixture-model");
  const spec = fixtureSpec("valid", bytes);
  try {
    const installed = await ensureLocalModel({
      cacheDir: root,
      spec,
      fetchImpl: async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
    });
    assert.equal(installed.ready, true);
    assert.equal(localModelStatus({ cacheDir: root, spec }).ready, true);
    await assert.rejects(
      ensureLocalModel({ cacheDir: root, spec: fixtureSpec("invalid", bytes, "0".repeat(64)), fetchImpl: async () => new Response(bytes) }),
      /SHA-256 verification/,
    );
    await assert.rejects(
      ensureLocalModel({ cacheDir: root, spec: fixtureSpec("offline", bytes), offline: true }),
      /offline mode/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment factory exposes the built-in local provider without downloading eagerly", () => {
  const embedder = createEmbedderFromEnv({
    CONTINUITYDB_EMBEDDING_PROVIDER: "local",
    CONTINUITYDB_HOME: "/tmp/continuitydb-not-created",
    CONTINUITYDB_LOCAL_MODEL_OFFLINE: "true",
  });
  assert.equal(embedder instanceof LocalOnnxEmbedder, true);
  assert.match(embedder.id, /^local:bge-small-en-v1\.5-q8:/);
});

test("local model installer refuses a symlinked model cache directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-model-link-test-"));
  const target = mkdtempSync(join(tmpdir(), "continuitydb-local-model-target-"));
  const bytes = Buffer.from("fixture-model");
  const spec = fixtureSpec("linked", bytes);
  try {
    symlinkSync(target, join(root, spec.cache_directory));
    await assert.rejects(
      ensureLocalModel({ cacheDir: root, spec, fetchImpl: async () => new Response(bytes) }),
      /real directory, not a symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
