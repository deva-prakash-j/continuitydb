import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { filesystemPathsEqual, isDirectEntrypoint } from "../src/direct-entry.js";

const testRoot = fileURLToPath(new URL("./", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const scriptsRoot = fileURLToPath(new URL("../scripts/", import.meta.url));

test("spawned test entrypoints convert file URLs with fileURLToPath", () => {
  const offenders = [];
  for (const name of readdirSync(testRoot).filter((entry) => entry.endsWith(".test.js")).sort()) {
    const source = readFileSync(join(testRoot, name), "utf8");
    if (/new URL\([^\n]*import\.meta\.url\)\.pathname/.test(source) || /\b[A-Z][A-Z0-9_]*\.pathname\b/.test(source)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], `file URL pathname is not a portable filesystem path: ${offenders.join(", ")}`);
});

test("runtime entrypoints compare decoded filesystem paths instead of interpolating file URLs", () => {
  const offenders = ["lifecycle-hook.js", "mcp-server.js", "http-server.js"].filter((name) => {
    const source = readFileSync(join(sourceRoot, name), "utf8");
    return /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/.test(source);
  });
  assert.deepEqual(offenders, [], `non-portable direct-entry guard: ${offenders.join(", ")}`);
});

test("direct-entry comparison follows Windows case-insensitive path semantics", () => {
  assert.equal(filesystemPathsEqual("D:\\Work\\ContinuityDB\\src\\mcp-server.js",
    "d:/work/continuitydb/src/mcp-server.js", { platform: "win32" }), true);
  assert.equal(filesystemPathsEqual("/Work/ContinuityDB/src/mcp-server.js",
    "/work/continuitydb/src/mcp-server.js", { platform: "linux" }), false);
  const target = join(sourceRoot, "mcp-server.js");
  assert.equal(isDirectEntrypoint(pathToFileURL(target).href, target, { platform: process.platform }), true);
  assert.equal(isDirectEntrypoint("file:///definitely/missing/continuitydb.js",
    "/definitely/missing/continuitydb.js", { platform: "linux" }), false);
});

test("advertised lifecycle executable runs through its real target and an npm-style symlink", {
  skip: process.platform === "win32" ? "npm uses command shims rather than POSIX symlinks on Windows" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-hook-symlink-"));
  const target = join(sourceRoot, "lifecycle-hook.js");
  const link = join(root, "continuitydb-hook");
  try {
    symlinkSync(target, link);
    for (const entrypoint of [target, link]) {
      const result = spawnSync(process.execPath, [entrypoint], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Usage:/, `${entrypoint} silently skipped its direct-entry action`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary smoke canonicalizes only its validator-owned temporary root", () => {
  const source = readFileSync(join(scriptsRoot, "binary-smoke.js"), "utf8");
  assert.match(source, /const root = realpathSync\(mkdtempSync\(join\(tmpdir\(\), "continuitydb-binary-smoke-"\)\)\);/);
});
