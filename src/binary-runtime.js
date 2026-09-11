import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { getAsset, isSea } from "node:sea";
import { join, resolve } from "node:path";

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

function validFile(path, specification) {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  const value = readFileSync(path);
  return value.byteLength === specification.bytes && sha256(value) === specification.sha256;
}

function writeAsset(directory, specification) {
  const destination = join(directory, specification.file);
  if (validFile(destination, specification)) return destination;
  const value = Buffer.from(getAsset(specification.asset));
  if (value.byteLength !== specification.bytes || sha256(value) !== specification.sha256) {
    throw new Error(`embedded runtime asset ${specification.asset} failed integrity verification`);
  }
  const temporary = join(directory, `.${specification.file}.${process.pid}.${randomUUID()}.part`);
  writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    if (!validFile(destination, specification)) throw error;
  }
  return destination;
}

export function isStandaloneBinary() {
  return isSea();
}

export function ensureEmbeddedOnnxRuntime({ home, cacheDir } = {}) {
  if (!isSea()) return null;
  const base = resolve(cacheDir || join(resolve(home || ".continuitydb"), "models"));
  const directory = join(base, ".runtime", RUNTIME_VERSION);
  if (existsSync(directory)) {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("embedded runtime cache must be a real directory, not a symlink");
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  chmodSync(directory, 0o700);
  const [wasmPath] = RUNTIME_ASSETS.map((specification) => writeAsset(directory, specification));
  return {
    directory,
    wasm: wasmPath,
  };
}

export const EMBEDDED_RUNTIME_SPEC = Object.freeze({
  version: RUNTIME_VERSION,
  assets: RUNTIME_ASSETS,
});
