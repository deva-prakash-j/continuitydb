import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRepository } from "../src/repo-ingest.js";

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

test("repository scanner indexes tracked symbols and dependencies but denies secret paths", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-repo-test-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "ApiClient.java"), "public class ApiClient { public void sendRequest() {} }\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { zod: "4.5.4" } }));
    writeFileSync(join(root, ".env"), "SHOULD_NOT_BE_READ=fixture\n");
    git(root, "init");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "add", ".");
    git(root, "commit", "-m", "fixture");
    writeFileSync(join(root, "src", "ApiClient.java"), "public class DirtyWorktreeOnly {}\n");

    const result = scanRepository(root, { projectId: "api" });
    assert.equal(result.scanned_files, 3);
    assert.equal(result.skipped.denied, 1);
    assert.ok(result.records.some((record) => record.repo_path === "src/ApiClient.java" && record.body.includes("ApiClient")));
    assert.equal(JSON.stringify(result).includes("DirtyWorktreeOnly"), false);
    assert.ok(result.records.every((record) => record.metadata.provenance_mode === "committed-blob"));
    assert.ok(result.records.some((record) => record.repo_path === "package.json" && record.body.includes("npm:zod@4.5.4")));
    assert.equal(JSON.stringify(result).includes("SHOULD_NOT_BE_READ"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
