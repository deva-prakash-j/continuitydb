import { acquireFileLock } from "../src/file-lock.js";

const [resource, mode = "hold"] = process.argv.slice(2);
if (!resource) throw new Error("resource path is required");

const release = acquireFileLock(resource, { timeoutMs: 5_000 });
process.stdout.write("acquired\n");

if (mode === "release") {
  release();
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  release();
  process.exit(0);
});
process.stdin.resume();
