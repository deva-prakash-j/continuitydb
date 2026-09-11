#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extension = process.platform === "win32" ? ".exe" : "";
const binary = resolve(process.env.CONTINUITYDB_BINARY_PATH || process.argv[2]
  || join("dist", `continuitydb-${process.platform}-${process.arch}${extension}`));
const root = mkdtempSync(join(tmpdir(), "continuitydb-binary-semantic-"));
const home = join(root, "vault");
const modelCache = join(home, "models");
const outside = join(root, "outside");
mkdirSync(modelCache, { recursive: true });
mkdirSync(outside);
symlinkSync(outside, join(modelCache, ".runtime"), process.platform === "win32" ? "junction" : "dir");

function run(args, environment = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ...environment },
  });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

try {
  const model = run(["embeddings-pull", "--home", home]);
  assert.equal(model.ready, true);
  const environment = {
    CONTINUITYDB_EMBEDDING_PROVIDER: "local",
    CONTINUITYDB_LOCAL_MODEL_OFFLINE: "true",
    CONTINUITYDB_OWNER_ID: "binary-semantic-owner",
    CONTINUITYDB_AGENT_ID: "binary-semantic-agent",
  };
  const captured = run([
    "capture", "--home", home, "--project", "api", "--kind", "working",
    "--body", "Breaking schema changes require regenerating downstream clients before deployment.",
  ], environment);
  assert.equal(captured.semantic_index.indexed, true);
  const searched = run([
    "search", "How should a downstream consumer react to a changed contract?",
    "--home", home, "--project", "api", "--allow-projects", "api",
  ], environment);
  assert.equal(searched.results.length, 1);
  assert.deepEqual(readdirSync(outside), [], "embedded runtime must not write through a cache symlink");
  process.stdout.write(`${JSON.stringify({
    passed: true,
    model_id: model.model_id,
    embedded_runtime: "onnxruntime-web wasm",
    semantic_indexed: true,
    results: searched.results.length,
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
