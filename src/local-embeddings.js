import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const REPOSITORY = "Xenova/bge-small-en-v1.5";
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const MODEL_DIRECTORY = "bge-small-en-v1.5-q8-ea104dac";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const sessions = new Map();
const verifiedModels = new Map();

export const BUILTIN_LOCAL_MODEL = Object.freeze({
  id: "local:bge-small-en-v1.5-q8:ea104dac",
  repository: REPOSITORY,
  upstream: "BAAI/bge-small-en-v1.5",
  revision: REVISION,
  license: "MIT",
  dimensions: 384,
  max_tokens: 512,
  query_prefix: QUERY_PREFIX,
  cache_directory: MODEL_DIRECTORY,
  artifacts: Object.freeze([
    Object.freeze({
      name: "model.onnx",
      path: "onnx/model_quantized.onnx",
      bytes: 34_014_426,
      sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
    }),
    Object.freeze({
      name: "vocab.txt",
      path: "vocab.txt",
      bytes: 231_508,
      sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    }),
  ]),
});

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validArtifact(path, artifact) {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  const bytes = readFileSync(path);
  return bytes.byteLength === artifact.bytes && sha256Buffer(bytes) === artifact.sha256;
}

function modelRoot(home, configuredCache, spec = BUILTIN_LOCAL_MODEL) {
  const base = configuredCache
    ? resolve(configuredCache)
    : join(resolve(home || process.env.CONTINUITYDB_HOME || process.env.CONTEXT_VAULT_HOME || ".continuitydb"), "models");
  return join(base, spec.cache_directory);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function acquireLock(path, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`);
      closeSync(descriptor);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 10 * 60_000) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for the local embedding model download lock");
      await sleep(250);
    }
  }
}

async function downloadArtifact(directory, artifact, fetchImpl, spec) {
  const url = `https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${artifact.path}`;
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`local embedding artifact download returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("local embedding artifact exceeds the download limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES || bytes.byteLength !== artifact.bytes) {
    throw new Error(`local embedding artifact ${artifact.name} has an unexpected size`);
  }
  if (sha256Buffer(bytes) !== artifact.sha256) {
    throw new Error(`local embedding artifact ${artifact.name} failed SHA-256 verification`);
  }
  const temporary = join(directory, `.${artifact.name}.${process.pid}.${randomUUID()}.part`);
  writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, artifact.name));
  chmodSync(join(directory, artifact.name), 0o600);
}

export function localModelStatus({ home, cacheDir, spec = BUILTIN_LOCAL_MODEL } = {}) {
  const directory = modelRoot(home, cacheDir, spec);
  const directorySafe = !existsSync(directory)
    || (lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
  const artifacts = spec.artifacts.map((artifact) => ({
    name: artifact.name,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    ready: directorySafe && validArtifact(join(directory, artifact.name), artifact),
  }));
  return {
    model_id: spec.id,
    repository: spec.repository,
    revision: spec.revision,
    license: spec.license,
    dimensions: spec.dimensions,
    directory,
    cache_directory_safe: directorySafe,
    ready: directorySafe && artifacts.every((artifact) => artifact.ready),
    download_bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    artifacts,
  };
}

export async function ensureLocalModel({ home, cacheDir, offline = false, fetchImpl = fetch, spec = BUILTIN_LOCAL_MODEL } = {}) {
  const cacheKey = modelRoot(home, cacheDir, spec);
  if (verifiedModels.has(cacheKey)) return verifiedModels.get(cacheKey);
  const status = localModelStatus({ home, cacheDir, spec });
  if (!status.cache_directory_safe) throw new Error("local embedding model cache must be a real directory, not a symlink");
  if (status.ready) {
    verifiedModels.set(cacheKey, status);
    return status;
  }
  if (offline) throw new Error("local embedding model is not cached and offline mode is enabled");
  mkdirSync(status.directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = lstatSync(status.directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("local embedding model cache must be a real directory, not a symlink");
  }
  chmodSync(status.directory, 0o700);
  const lock = join(status.directory, ".download.lock");
  await acquireLock(lock);
  try {
    for (const artifact of spec.artifacts) {
      const destination = join(status.directory, artifact.name);
      if (!validArtifact(destination, artifact)) await downloadArtifact(status.directory, artifact, fetchImpl, spec);
    }
  } finally {
    try { unlinkSync(lock); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const completed = localModelStatus({ home, cacheDir, spec });
  if (!completed.ready) throw new Error("local embedding model installation did not complete");
  verifiedModels.set(cacheKey, completed);
  return completed;
}

export function normalizeEmbeddingText(value) {
  return String(value).slice(0, 32_768)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.:/\\-]+/g, " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

export class WordPieceTokenizer {
  constructor(vocabulary, { maxTokens = BUILTIN_LOCAL_MODEL.max_tokens } = {}) {
    this.vocabulary = vocabulary;
    this.maxTokens = boundedInteger(maxTokens, 512, 8, 512, "maxTokens");
    this.pad = this.id("[PAD]");
    this.unknown = this.id("[UNK]");
    this.cls = this.id("[CLS]");
    this.sep = this.id("[SEP]");
  }

  static fromFile(path, options) {
    const vocabulary = new Map(readFileSync(path, "utf8").split(/\r?\n/).map((token, index) => [token, index]));
    return new WordPieceTokenizer(vocabulary, options);
  }

  id(token) {
    const id = this.vocabulary.get(token);
    if (id === undefined) throw new Error(`local embedding vocabulary is missing ${token}`);
    return id;
  }

  wordPieces(word) {
    if (word.length > 100) return [this.unknown];
    const output = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found;
      while (start < end) {
        const piece = `${start ? "##" : ""}${word.slice(start, end)}`;
        if (this.vocabulary.has(piece)) { found = piece; break; }
        end -= 1;
      }
      if (!found) return [this.unknown];
      output.push(this.vocabulary.get(found));
      start = end;
    }
    return output;
  }

  encode(value) {
    const normalized = normalizeEmbeddingText(value);
    const words = normalized.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];
    const pieces = [];
    for (const word of words) {
      pieces.push(...this.wordPieces(word));
      if (pieces.length >= this.maxTokens - 2) break;
    }
    return [this.cls, ...pieces.slice(0, this.maxTokens - 2), this.sep];
  }
}

async function loadSession(status, threads) {
  const key = `${status.directory}:${threads}`;
  if (!sessions.has(key)) {
    sessions.set(key, (async () => {
      let ort;
      try { ort = await import("onnxruntime-web"); }
      catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") {
          throw new Error("local embeddings require the optional onnxruntime-web dependency; reinstall without --omit=optional");
        }
        throw error;
      }
      ort.env.wasm.numThreads = threads;
      ort.env.wasm.proxy = false;
      const tokenizer = WordPieceTokenizer.fromFile(join(status.directory, "vocab.txt"));
      const session = await ort.InferenceSession.create(join(status.directory, "model.onnx"), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return { ort, tokenizer, session };
    })());
  }
  return sessions.get(key);
}

function meanPool(data, mask, batchSize, sequenceLength, dimensions) {
  const output = [];
  for (let batch = 0; batch < batchSize; batch += 1) {
    const vector = new Array(dimensions).fill(0);
    let count = 0;
    for (let token = 0; token < sequenceLength; token += 1) {
      if (!mask[batch * sequenceLength + token]) continue;
      count += 1;
      const offset = (batch * sequenceLength + token) * dimensions;
      for (let dimension = 0; dimension < dimensions; dimension += 1) vector[dimension] += data[offset + dimension];
    }
    let norm = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      vector[dimension] /= Math.max(1, count);
      norm += vector[dimension] ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    output.push(vector.map((value) => value / norm));
  }
  return output;
}

export class LocalOnnxEmbedder {
  constructor({ home, cacheDir, offline = false, threads = 1, batchSize = 32 } = {}) {
    this.home = home;
    this.cacheDir = cacheDir;
    this.offline = Boolean(offline);
    this.threads = boundedInteger(threads, 1, 1, 8, "local embedding threads");
    this.batchSize = boundedInteger(batchSize, 32, 1, 64, "local embedding batch size");
    this.id = BUILTIN_LOCAL_MODEL.id;
  }

  async ready() {
    const status = await ensureLocalModel({ home: this.home, cacheDir: this.cacheDir, offline: this.offline });
    await loadSession(status, this.threads);
    return status;
  }

  async embedDocuments(texts) {
    return this.embed(texts);
  }

  async embedQuery(text) {
    return (await this.embed(`${QUERY_PREFIX}${text}`))[0];
  }

  async embed(texts) {
    const input = Array.isArray(texts) ? texts : [texts];
    if (!input.length || input.length > 256) throw new Error("embedding batch must contain 1 to 256 items");
    const status = await ensureLocalModel({ home: this.home, cacheDir: this.cacheDir, offline: this.offline });
    const { ort, tokenizer, session } = await loadSession(status, this.threads);
    const vectors = [];
    for (let offset = 0; offset < input.length; offset += this.batchSize) {
      const batch = input.slice(offset, offset + this.batchSize).map((value) => tokenizer.encode(value));
      const sequenceLength = Math.max(...batch.map((tokens) => tokens.length));
      const ids = new BigInt64Array(batch.length * sequenceLength);
      const mask = new BigInt64Array(batch.length * sequenceLength);
      const types = new BigInt64Array(batch.length * sequenceLength);
      ids.fill(BigInt(tokenizer.pad));
      batch.forEach((tokens, batchIndex) => tokens.forEach((token, tokenIndex) => {
        const index = batchIndex * sequenceLength + tokenIndex;
        ids[index] = BigInt(token);
        mask[index] = 1n;
      }));
      const shape = [batch.length, sequenceLength];
      const result = await session.run({
        input_ids: new ort.Tensor("int64", ids, shape),
        attention_mask: new ort.Tensor("int64", mask, shape),
        token_type_ids: new ort.Tensor("int64", types, shape),
      });
      const hidden = result.last_hidden_state;
      if (!hidden || hidden.dims[0] !== batch.length || hidden.dims[2] !== BUILTIN_LOCAL_MODEL.dimensions) {
        throw new Error("local embedding model returned an unexpected tensor shape");
      }
      vectors.push(...meanPool(hidden.data, mask, batch.length, sequenceLength, BUILTIN_LOCAL_MODEL.dimensions));
    }
    return vectors;
  }
}
