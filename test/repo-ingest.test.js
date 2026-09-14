import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCommittedSnapshot, scanRepository } from "../src/repo-ingest.js";

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

test("committed snapshots are root-bound, blob-only, limited, and safe to share with record ingest", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-snapshot-test-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "README.md"), "Committed README\n");
    writeFileSync(join(root, "src", "Api.java"), "public class Api {}\n");
    writeFileSync(join(root, ".env"), "SECRET=committed\n");
    writeFileSync(join(root, "large.md"), "x".repeat(80));
    symlinkSync("README.md", join(root, "readme-link.md"));
    git(root, "init");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "remote", "add", "origin", "https://user:password@example.invalid/acme/api.git");
    git(root, "add", ".");
    git(root, "commit", "-m", "fixture");
    writeFileSync(join(root, "README.md"), "Dirty worktree text\n");

    const snapshot = readCommittedSnapshot(root, { projectId: "api", maxFiles: 20, maxFileBytes: 32 });
    assert.equal(snapshot.repository.remote, "https://example.invalid/acme/api.git");
    assert.ok(snapshot.files.some((file) => file.repo_path === "README.md" && file.bytes.toString("utf8") === "Committed README\n"));
    assert.equal(JSON.stringify(snapshot).includes("Dirty worktree text"), false);
    assert.equal(snapshot.files.some((file) => file.repo_path === ".env"), false);
    assert.equal(snapshot.files.some((file) => file.repo_path === "readme-link.md"), false);
    assert.equal(snapshot.skipped.denied, 1);
    assert.equal(snapshot.skipped.symlink, 1);
    assert.equal(snapshot.skipped.too_large, 1);
    assert.throws(() => readCommittedSnapshot(join(root, "src")), /Git repository root/);
    const limited = readCommittedSnapshot(root, { projectId: "api", maxFiles: 2, maxFileBytes: 32 });
    assert.equal(limited.truncated, true);
    assert.equal(limited.scanned_files, 2);

    const scan = scanRepository(root, { projectId: "api", maxFiles: 20, maxFileBytes: 32 });
    assert.equal(scan.scanned_files, 5);
    assert.equal(scan.produced_records, 2);
    assert.deepEqual(scan.skipped, snapshot.skipped);
    assert.equal(JSON.stringify(scan).includes("Committed README"), true);
    assert.equal(JSON.stringify(scan).includes("Dirty worktree text"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
