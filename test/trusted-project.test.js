import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { listRegisteredProjects } from "../src/project-registry.js";
import {
  ensureTrustedProject,
  pathIsInsideWorkspace,
  projectIdForCanonicalRoot,
} from "../src/trusted-project.js";

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

test("trusted project ensure registers once and reuses the root mapping", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-trusted-project-"));
  const workspace = join(root, "workspace");
  const repo = repository(workspace, "billing-api");
  const home = join(root, "vault");
  try {
    const preview = ensureTrustedProject(home, {
      directory: join(repo, "src"), worktree: repo, workspaceRoots: [workspace], apply: false,
    });
    assert.deepEqual(preview.project, { id: "billing-api", root: repo, source: "git" });
    assert.equal(preview.changed, true);
    assert.equal(preview.applied, false);
    assert.deepEqual(listRegisteredProjects(home), []);

    const first = ensureTrustedProject(home, {
      directory: repo, worktree: repo, workspaceRoots: [workspace], apply: true,
    });
    const second = ensureTrustedProject(home, {
      directory: join(repo, "src"), worktree: repo, workspaceRoots: [workspace], apply: true,
    });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(second.project, first.project);
    assert.deepEqual(listRegisteredProjects(home), [first.project]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("duplicate repository basenames receive stable root-derived project IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-trusted-collision-"));
  const one = join(root, "one");
  const two = join(root, "two");
  const repoOne = repository(one, "service");
  const repoTwo = repository(two, "service");
  const home = join(root, "vault");
  try {
    const first = ensureTrustedProject(home, { directory: repoOne, workspaceRoots: [one, two], apply: true });
    const second = ensureTrustedProject(home, { directory: repoTwo, workspaceRoots: [one, two], apply: true });
    assert.equal(first.project.id, "service");
    assert.match(second.project.id, /^service-[a-f0-9]{12}$/);
    assert.equal(
      second.project.id,
      projectIdForCanonicalRoot(repoTwo, listRegisteredProjects(home)),
    );
    assert.equal(ensureTrustedProject(home, {
      directory: repoTwo, workspaceRoots: [one, two], apply: true,
    }).project.id, second.project.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted project ensure rejects repositories outside roots and symlinked git markers", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-trusted-deny-"));
  const workspace = join(root, "workspace");
  const outside = repository(join(root, "outside"), "repo");
  const linked = join(workspace, "linked");
  const actualGit = join(root, "actual-git");
  mkdirSync(linked, { recursive: true });
  mkdirSync(actualGit);
  symlinkSync(actualGit, join(linked, ".git"));
  try {
    assert.throws(
      () => ensureTrustedProject(join(root, "vault"), {
        directory: outside, workspaceRoots: [workspace], apply: true,
      }),
      /outside trusted workspace roots/i,
    );
    assert.throws(
      () => ensureTrustedProject(join(root, "vault"), {
        directory: linked, workspaceRoots: [workspace], apply: true,
      }),
      /\.git.*symbolic link/i,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("path containment is separator-aware and Windows case-insensitive", () => {
  assert.equal(pathIsInsideWorkspace("C:\\Repos", "c:\\repos\\AgentForge", "win32"), true);
  assert.equal(pathIsInsideWorkspace("C:\\Repos", "C:\\ReposElsewhere\\AgentForge", "win32"), false);
  assert.equal(pathIsInsideWorkspace("D:\\Repos", "C:\\Repos\\AgentForge", "win32"), false);
  assert.equal(pathIsInsideWorkspace("/work/repos", "/work/repos/agentforge", "linux"), true);
  assert.equal(pathIsInsideWorkspace("/work/Repos", "/work/repos/agentforge", "linux"), false);
});

test("root-derived collision IDs are deterministic after path normalization", () => {
  const projects = [{ id: "service", root: resolve("/existing/service"), source: "git" }];
  const first = projectIdForCanonicalRoot(resolve("/other/service"), projects);
  const second = projectIdForCanonicalRoot(resolve("/other/service"), [...projects].reverse());
  assert.equal(first, second);
  assert.match(first, /^service-[a-f0-9]{12}$/);
});
