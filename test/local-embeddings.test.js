import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEmbedderFromEnv } from "../src/embeddings.js";
import {
  acquireLocalModelCacheLock,
  ensureLocalModel,
  localModelStatus,
  LocalOnnxEmbedder,
  normalizeEmbeddingText,
  restoreLocalModelCache,
  snapshotLocalModelCache,
  WordPieceTokenizer,
} from "../src/local-embeddings.js";

const LOCK_WORKER = fileURLToPath(new URL("../test-support/file-lock-worker.mjs", import.meta.url));

function waitForLine(child, expected, timeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expected}; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk;
      if (stdout.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolvePromise();
      }
    };
    const onStderr = (chunk) => { stderr += chunk; };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`worker exited before ${expected}: code=${code} signal=${signal}; stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

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

test("local model cache transaction removes new artifacts and restores overwritten files", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-model-transaction-"));
  const bytes = Buffer.from("fixture-model");
  const spec = fixtureSpec("transactional", bytes);
  const modelDirectory = join(root, spec.cache_directory);
  try {
    const empty = snapshotLocalModelCache({ cacheDir: root, spec });
    await ensureLocalModel({
      cacheDir: root,
      spec,
      fetchImpl: async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
    });
    const installedEmpty = snapshotLocalModelCache({ cacheDir: root, spec });
    restoreLocalModelCache(empty, installedEmpty);
    assert.equal(existsSync(modelDirectory), false, "new external model directory must be removed on rollback");

    mkdirSync(modelDirectory, { recursive: true });
    const artifact = join(modelDirectory, "model.onnx");
    writeFileSync(artifact, "pre-existing-invalid-model");
    const existing = snapshotLocalModelCache({ cacheDir: root, spec });
    await ensureLocalModel({
      cacheDir: root,
      spec,
      fetchImpl: async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
    });
    const installedExisting = snapshotLocalModelCache({ cacheDir: root, spec });
    restoreLocalModelCache(existing, installedExisting);
    assert.equal(readFileSync(artifact, "utf8"), "pre-existing-invalid-model");
    assert.equal(localModelStatus({ cacheDir: root, spec }).ready, false, "rollback must invalidate the verified cache entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local model rollback preserves a concurrent cache writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-model-concurrent-"));
  const bytes = Buffer.from("fixture-model");
  const spec = fixtureSpec("concurrent", bytes);
  try {
    const before = snapshotLocalModelCache({ cacheDir: root, spec });
    await ensureLocalModel({
      cacheDir: root,
      spec,
      fetchImpl: async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
    });
    const written = snapshotLocalModelCache({ cacheDir: root, spec });
    const artifact = join(root, spec.cache_directory, "model.onnx");
    writeFileSync(artifact, "concurrent-writer");
    assert.throws(
      () => restoreLocalModelCache(before, written),
      /rollback conflict: local embedding cache changed concurrently/,
    );
    assert.equal(readFileSync(artifact, "utf8"), "concurrent-writer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup-style outer cache lock serializes snapshot, install, and rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-local-model-outer-lock-"));
  const bytes = Buffer.from("fixture-model");
  const spec = fixtureSpec("outer-lock", bytes);
  const lockResource = join(root, spec.cache_directory, ".download.lock");
  const releaseOuter = acquireLocalModelCacheLock({ cacheDir: root, spec });
  let worker;
  try {
    const before = snapshotLocalModelCache({ cacheDir: root, spec });
    await ensureLocalModel({
      cacheDir: root,
      spec,
      fetchImpl: async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
    });
    const written = snapshotLocalModelCache({ cacheDir: root, spec });

    worker = spawn(process.execPath, [LOCK_WORKER, lockResource, "release"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let acquired = false;
    worker.stdout.on("data", (chunk) => {
      if (String(chunk).split(/\r?\n/).includes("acquired")) acquired = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    assert.equal(acquired, false, "competing cache writer entered before setup rollback completed");

    restoreLocalModelCache(before, written);
    assert.equal(existsSync(join(root, spec.cache_directory)), false);
    const acquiredAfterRelease = waitForLine(worker, "acquired");
    releaseOuter();
    await acquiredAfterRelease;
    assert.equal(await new Promise((resolvePromise) => worker.once("exit", resolvePromise)), 0);
    worker = null;
  } finally {
    releaseOuter();
    if (worker?.exitCode === null) worker.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
