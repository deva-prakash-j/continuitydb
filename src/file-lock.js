import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HELD_LOCKS = new Map();

function lockDirectory() {
  const identity = typeof process.getuid === "function" ? String(process.getuid()) : "default";
  const directory = join(tmpdir(), `continuitydb-resource-locks-${identity}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`resource lock directory must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`resource lock directory must be owned by the current user: ${directory}`);
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function databasePath(resourcePath) {
  const digest = createHash("sha256").update(resolve(resourcePath)).digest("hex");
  return join(lockDirectory(), `${digest}.sqlite`);
}

export function acquireFileLock(lockPath, { timeoutMs = 15_000 } = {}) {
  const resource = resolve(lockPath);
  const held = HELD_LOCKS.get(resource);
  if (held) {
    held.depth += 1;
    return () => {
      const current = HELD_LOCKS.get(resource);
      if (!current) return;
      current.depth -= 1;
      if (current.depth === 0) current.release();
    };
  }

  const path = databasePath(resource);
  if (!existsSync(path)) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      closeSync(descriptor);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`resource lock database must be a regular file: ${path}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`resource lock database must be owned by the current user: ${path}`);
    }
  }
  const database = new DatabaseSync(path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    if (String(error?.code || "").includes("BUSY")) {
      throw new Error(`timed out waiting for lock: ${resource}`);
    }
    throw error;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { database.exec("COMMIT"); }
    finally {
      database.close();
      HELD_LOCKS.delete(resource);
    }
  };
  HELD_LOCKS.set(resource, { depth: 1, release });
  return () => {
    const current = HELD_LOCKS.get(resource);
    if (!current) return;
    current.depth -= 1;
    if (current.depth === 0) current.release();
  };
}

export function acquireFileLocks(lockPaths, options) {
  const releases = [];
  try {
    for (const path of [...new Set(lockPaths.map((value) => resolve(value)))].sort()) {
      releases.push(acquireFileLock(path, options));
    }
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  return () => {
    const errors = [];
    for (const release of releases.reverse()) {
      try { release(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "failed to release resource locks");
  };
}

export function vaultInitializationLockPath(rootDir) {
  const home = resolve(rootDir);
  return join(dirname(home), `.${basename(home)}.continuitydb-init.lock`);
}

export function acquireVaultInitializationLock(rootDir, options) {
  return acquireFileLock(vaultInitializationLockPath(rootDir), options);
}
