import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const HELD_LOCKS = new Map();

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removeDeadOwner(lockPath) {
  let metadata;
  try { metadata = lstatSync(lockPath); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`lock path must be a regular file, not a symlink: ${lockPath}`);
  }
  let owner;
  try { owner = JSON.parse(readFileSync(lockPath, "utf8")); }
  catch { return false; }
  if (processExists(Number(owner?.pid))) return false;
  try { unlinkSync(lockPath); return true; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

export function acquireFileLock(lockPath, { timeoutMs = 15_000 } = {}) {
  const path = resolve(lockPath);
  const held = HELD_LOCKS.get(path);
  if (held) {
    held.depth += 1;
    return () => {
      held.depth -= 1;
      if (held.depth === 0) held.release();
    };
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  const token = randomUUID();
  const payload = `${JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })}\n`;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, payload);
      chmodSync(path, 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (removeDeadOwner(path)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${path}`);
      Atomics.wait(WAIT_BUFFER, 0, 0, 25);
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { closeSync(descriptor); }
    finally {
      try {
        if (readFileSync(path, "utf8") !== payload) throw new Error(`lock ownership changed before release: ${path}`);
        unlinkSync(path);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      HELD_LOCKS.delete(path);
    }
  };
  HELD_LOCKS.set(path, { depth: 1, release });
  return () => {
    const current = HELD_LOCKS.get(path);
    if (!current) return;
    current.depth -= 1;
    if (current.depth === 0) current.release();
  };
}

export function vaultInitializationLockPath(rootDir) {
  const home = resolve(rootDir);
  return join(dirname(home), `.${basename(home)}.continuitydb-init.lock`);
}

export function acquireVaultInitializationLock(rootDir, options) {
  return acquireFileLock(vaultInitializationLockPath(rootDir), options);
}
