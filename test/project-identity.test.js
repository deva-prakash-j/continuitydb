import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { resolveProjectIdentity, validateProjectId } from "../src/project-identity.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-project-identity-"));
  const repo = join(root, "billing-api");
  const nested = join(repo, "packages", "worker");
  mkdirSync(join(nested, "src"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  return { root, repo, nested };
}

test("nested paths use the Git root basename", () => {
  const { root, repo, nested } = fixture();
  try {
    const identity = resolveProjectIdentity({ projectDir: nested });
    assert.deepEqual(identity, { id: "billing-api", root: repo, source: "git", git_root: repo });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit project IDs are used outside a Git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-project-identity-explicit-"));
  try {
    const identity = resolveProjectIdentity({ projectDir: root, explicitProject: "billing-api" });
    assert.deepEqual(identity, { id: "billing-api", root, source: "explicit", git_root: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside a Git repository requires an explicit project", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-project-identity-outside-"));
  try {
    assert.throws(
      () => resolveProjectIdentity({ projectDir: root }),
      /cannot infer a project identity.*--project <id>/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a .git symlink is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-project-identity-symlink-"));
  const repo = join(root, "repo");
  const target = join(root, "actual-git");
  mkdirSync(repo);
  mkdirSync(target);
  symlinkSync(target, join(repo, ".git"));
  try {
    assert.throws(() => resolveProjectIdentity({ projectDir: repo }), /\.git.*symbolic link|symbolic link.*\.git/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a regular-file .git marker identifies the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-project-identity-file-git-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, ".git"), "gitdir: /somewhere\n");
  try {
    assert.deepEqual(resolveProjectIdentity({ projectDir: repo }), {
      id: basename(repo), root: repo, source: "git", git_root: repo,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateProjectId applies the existing project-ID grammar", () => {
  assert.equal(validateProjectId("billing-api/v2"), "billing-api/v2");
  for (const value of ["", ".bad", "-bad", "bad id", "x".repeat(201), null]) {
    assert.throws(() => validateProjectId(value), /invalid project identifier/);
  }
});
