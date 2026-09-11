import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EMBEDDED_RUNTIME_SPEC, ensureEmbeddedOnnxRuntime } from "../src/binary-runtime.js";

const wasmPath = new URL("../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url);

test("standalone runtime verifies WASM in memory and never follows cache symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-runtime-memory-"));
  const cache = join(root, "models");
  const outside = join(root, "outside");
  mkdirSync(cache);
  mkdirSync(outside);
  symlinkSync(outside, join(cache, ".runtime"));
  const bytes = readFileSync(wasmPath);
  try {
    const runtime = ensureEmbeddedOnnxRuntime({
      standalone: true,
      assetLoader: (name) => {
        assert.equal(name, EMBEDDED_RUNTIME_SPEC.assets[0].asset);
        return bytes;
      },
      cacheDir: cache,
    });
    assert.equal(runtime.version, EMBEDDED_RUNTIME_SPEC.version);
    assert.equal(runtime.wasmBinary.byteLength, bytes.byteLength);
    assert.equal(existsSync(join(outside, EMBEDDED_RUNTIME_SPEC.version)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone runtime rejects corrupted embedded WASM before inference", () => {
  const bytes = readFileSync(wasmPath);
  bytes[0] ^= 0xff;
  assert.throws(
    () => ensureEmbeddedOnnxRuntime({ standalone: true, assetLoader: () => bytes }),
    /failed integrity verification/,
  );
});

test("source runtime does not request a SEA asset", () => {
  assert.equal(ensureEmbeddedOnnxRuntime({
    standalone: false,
    assetLoader: () => { throw new Error("must not load"); },
  }), null);
});
