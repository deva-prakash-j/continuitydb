#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const maxBuffer = 64 * 1024 * 1024;

if (process.platform !== "linux") throw new Error("binary reproducibility proof currently targets Linux");
const temporaryRoot = mkdtempSync(join(tmpdir(), "continuitydb-reproducible-build-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer, ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed with status ${result.status}`);
  }
  return result.stdout;
}

function buildCleanCheckout(name, tempName) {
  const checkout = join(temporaryRoot, name);
  const buildTemp = join(temporaryRoot, tempName);
  mkdirSync(checkout, { recursive: true, mode: 0o700 });
  mkdirSync(buildTemp, { recursive: true, mode: 0o700 });
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: root, maxBuffer });
  if (archive.status !== 0) throw new Error(archive.stderr?.toString() || "git archive failed");
  const extract = spawnSync("tar", ["-x", "-C", checkout], { input: archive.stdout, maxBuffer });
  if (extract.status !== 0) throw new Error(extract.stderr?.toString() || "git archive extraction failed");
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: checkout });
  const outputDirectory = join(checkout, "dist-proof");
  run(process.execPath, [join(checkout, "scripts", "build-binary.js")], {
    cwd: checkout,
    env: {
      ...process.env,
      TMPDIR: buildTemp,
      TMP: buildTemp,
      TEMP: buildTemp,
      CONTINUITYDB_BINARY_OUT: outputDirectory,
    },
  });
  const binary = join(outputDirectory, `continuitydb-${process.platform}-${process.arch}`);
  const bytes = readFileSync(binary);
  return {
    checkout,
    buildTemp,
    binary,
    bytes: statSync(binary).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

try {
  const first = buildCleanCheckout("checkout-a", "tmp-a");
  const second = buildCleanCheckout("checkout-b", "tmp-b");
  if (first.bytes !== second.bytes || first.sha256 !== second.sha256) {
    throw new Error(`clean-directory binaries differ: ${first.sha256} != ${second.sha256}`);
  }
  process.stdout.write(`${JSON.stringify({
    reproducible: true,
    directories: [first.checkout, second.checkout],
    temporaryDirectories: [first.buildTemp, second.buildTemp],
    bytes: first.bytes,
    sha256: first.sha256,
  }, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
