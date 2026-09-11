#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const directory = resolve(process.argv[2] || "dist");
const files = readdirSync(directory).filter((name) => name.startsWith("continuitydb-") && !name.endsWith(".sha256"));
if (!files.length) throw new Error(`no ContinuityDB binaries found in ${directory}`);
const output = [];
for (const name of files.sort()) {
  const path = join(directory, name);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`, { mode: 0o600 });
  output.push({ name, sha256: digest });
}
process.stdout.write(`${JSON.stringify({ checksums: output }, null, 2)}\n`);
