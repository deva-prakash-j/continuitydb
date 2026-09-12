import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testRoot = fileURLToPath(new URL("./", import.meta.url));

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
