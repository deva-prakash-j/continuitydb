import { createHash } from "node:crypto";
import { getAsset, isSea } from "node:sea";

const RUNTIME_VERSION = "onnxruntime-web-1.29.0";
const RUNTIME_ASSETS = Object.freeze([
  Object.freeze({
    asset: "onnxruntime.wasm",
    file: "ort-wasm-simd-threaded.wasm",
    bytes: 13_961_845,
    sha256: "ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d",
  }),
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isStandaloneBinary() {
  return isSea();
}

export function ensureEmbeddedOnnxRuntime({ standalone = isSea(), assetLoader = getAsset } = {}) {
  if (!standalone) return null;
  const specification = RUNTIME_ASSETS[0];
  const wasmBinary = Buffer.from(assetLoader(specification.asset));
  if (wasmBinary.byteLength !== specification.bytes || sha256(wasmBinary) !== specification.sha256) {
    throw new Error(`embedded runtime asset ${specification.asset} failed integrity verification`);
  }
  return {
    version: RUNTIME_VERSION,
    wasmBinary,
  };
}

export const EMBEDDED_RUNTIME_SPEC = Object.freeze({
  version: RUNTIME_VERSION,
  assets: RUNTIME_ASSETS,
});
