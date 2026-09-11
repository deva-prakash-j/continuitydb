import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { acquireFileLock } from "../src/file-lock.js";

const WORKER = new URL("../test-support/file-lock-worker.mjs", import.meta.url);

function worker(resource, mode = "hold") {
  return spawn(process.execPath, [WORKER.pathname, resource, mode], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForLine(child, expected, timeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expected}; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk;
      if (stdout.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolvePromise();
      }
    };
    const onStderr = (chunk) => { stderr += chunk; };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`worker exited before ${expected}: code=${code} signal=${signal}; stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => reject(new Error("timed out waiting for worker exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

test("resource locks are re-entrant within one process", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-lock-reentrant-"));
  try {
    const resource = join(root, "resource.lock");
    const releaseOuter = acquireFileLock(resource);
    const releaseInner = acquireFileLock(resource);
    releaseInner();
    releaseOuter();
    assert.doesNotThrow(() => acquireFileLock(resource)());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource locks serialize two processes without overlapping ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-lock-serialize-"));
  const first = worker(join(root, "resource.lock"));
  let second;
  try {
    await waitForLine(first, "acquired");
    second = worker(join(root, "resource.lock"));
    let secondAcquired = false;
    second.stdout.on("data", (chunk) => {
      if (String(chunk).split(/\r?\n/).includes("acquired")) secondAcquired = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    assert.equal(secondAcquired, false, "second process entered while first still held the lock");
    const secondReady = waitForLine(second, "acquired");
    first.stdin.end("release\n");
    await waitForExit(first);
    await secondReady;
    second.stdin.end("release\n");
    assert.deepEqual(await waitForExit(second), { code: 0, signal: null });
  } finally {
    if (first.exitCode === null) first.kill();
    if (second?.exitCode === null) second.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource lock ownership is released automatically when the owner crashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-lock-crash-"));
  const resource = join(root, "resource.lock");
  const crashed = worker(resource);
  try {
    await waitForLine(crashed, "acquired");
    crashed.kill("SIGKILL");
    await waitForExit(crashed);
    const successor = worker(resource, "release");
    await waitForLine(successor, "acquired");
    assert.deepEqual(await waitForExit(successor), { code: 0, signal: null });
  } finally {
    if (crashed.exitCode === null) crashed.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy malformed lock-path residue cannot wedge the SQLite-backed lock", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-lock-residue-"));
  try {
    const fileResource = join(root, "malformed.lock");
    writeFileSync(fileResource, "not-json\n");
    assert.doesNotThrow(() => acquireFileLock(fileResource)());

    const directoryResource = join(root, "directory.lock");
    mkdirSync(directoryResource);
    assert.equal(existsSync(directoryResource), true);
    assert.doesNotThrow(() => acquireFileLock(directoryResource)());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
