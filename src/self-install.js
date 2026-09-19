import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { defaultInstallPrefix } from "./agent-connectors.js";
import { isStandaloneBinary } from "./binary-runtime.js";
import { acquireFileLock } from "./file-lock.js";
import { VERSION } from "./version.js";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureDirectory(path, createdDirectories = null) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`installation path must be a real directory: ${path}`);
  } else {
    mkdirSync(path, { mode: 0o700 });
    createdDirectories?.push(path);
  }
}

function assertNoSymlinkAncestors(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`installation path must not traverse a symlink: ${current}`);
    }
  }
}

export function canonicalInstallPrefix(prefix, platform = process.platform) {
  const absolute = resolve(prefix);
  // macOS exposes /var as the OS-owned /private/var compatibility link. Temp
  // directories live below it, so canonicalize that one trusted system alias
  // before enforcing the no-symlink-ancestor rule. No user-controlled symlink
  // is followed or allowlisted.
  if (platform === "darwin" && (absolute === "/var" || absolute.startsWith(`/var${sep}`))) {
    return join("/private/var", relative("/var", absolute));
  }
  return absolute;
}

function isManagedLauncher(path, managedRoot) {
  if (!lstatSync(path).isSymbolicLink()) return false;
  const target = resolve(dirname(path), readlinkSync(path));
  const value = relative(managedRoot, target);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function isManagedWindowsLauncher(path, managedRoot) {
  // Windows launchers are copies, not links. Match an already installed release
  // before staging the incoming version, including installs predating manifests.
  if (!lstatSync(path).isFile()) return false;
  assertNoSymlinkAncestors(managedRoot);
  if (!existsSync(managedRoot)) return false;
  const digest = sha256(path);
  return readdirSync(managedRoot, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.name)) return false;
    const binary = join(managedRoot, entry.name, "continuitydb.exe");
    const metadata = lstatSafe(binary);
    return Boolean(metadata?.isFile() && !metadata.isSymbolicLink() && sha256(binary) === digest);
  });
}

function backupLauncher(path, installationPrefix, createdDirectories) {
  const directory = join(installationPrefix, "lib", "continuitydb", "backups");
  ensureDirectory(directory, createdDirectories);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    const target = readlinkSync(path);
    const destination = join(directory, `launcher-${sha256Text(target).slice(0, 16)}.link.txt`);
    const created = !existsSync(destination);
    if (created) writeFilePrivate(destination, `${target}\n`);
    return { path: destination, created };
  }
  if (!metadata.isFile()) throw new Error(`existing launcher is not a regular file or symlink: ${path}`);
  const destination = join(directory, `launcher-${sha256(path).slice(0, 16)}.bak`);
  const created = !existsSync(destination);
  if (created) {
    copyFileSync(path, destination);
    chmodSync(destination, 0o600);
  }
  return { path: destination, created };
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFilePrivate(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function entrySnapshot(path) {
  if (!existsSync(path) && !lstatSafe(path)) return { existed: false, type: null, bytes: null, target: null, mode: null };
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    return { existed: true, type: "link", bytes: null, target: readlinkSync(path), mode: null };
  }
  if (!metadata.isFile()) throw new Error(`installation target must be a regular file or symlink: ${path}`);
  return { existed: true, type: "file", bytes: readFileSync(path), target: null, mode: metadata.mode & 0o777 };
}

function sameEntry(left, right) {
  if (left.existed !== right.existed || left.type !== right.type || left.target !== right.target || left.mode !== right.mode) return false;
  if (!left.bytes && !right.bytes) return true;
  return Boolean(left.bytes && right.bytes && left.bytes.equals(right.bytes));
}

function restoreEntry(path, original, expectedCurrent) {
  const current = entrySnapshot(path);
  if (!sameEntry(current, expectedCurrent)) {
    throw new Error(`rollback conflict: installation target changed concurrently: ${path}`);
  }
  if (current.existed) unlinkSync(path);
  if (!original.existed) return;
  if (original.type === "link") {
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.rollback-link`);
    symlinkSync(original.target, temporary);
    renameSync(temporary, path);
    return;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.rollback`);
  writeFileSync(temporary, original.bytes, { flag: "wx", mode: original.mode || 0o600 });
  renameSync(temporary, path);
  chmodSync(path, original.mode || 0o600);
}

function removeCreatedDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    if (!existsSync(directory)) continue;
    try { rmdirSync(directory); }
    catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; }
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sameCanonicalPath(left, right, platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function installGuidance({ binDirectory, pathConfigured, platform }) {
  const nextSteps = [];
  if (!pathConfigured) {
    nextSteps.push(platform === "win32"
      ? `Add "${binDirectory}" to your user PATH in Windows Environment Variables.`
      : `export PATH=${shellSingleQuote(binDirectory)}:$PATH`);
  }
  nextSteps.push("continuitydb version");
  return {
    shell_profile_modified: false,
    path_configured: pathConfigured,
    path_entry: binDirectory,
    next_steps: nextSteps,
  };
}

export function installStandaloneBinary({
  source = process.execPath,
  prefix = defaultInstallPrefix(),
  apply = false,
  force = false,
  standalone = isStandaloneBinary(),
  platform = process.platform,
  version = VERSION,
  pathValue = process.env.PATH || "",
  _testBeforeLauncherCommit = null,
} = {}) {
  if (!standalone) throw new Error("self-install is available only from a standalone ContinuityDB binary");
  const sourcePath = realpathSync(source);
  const metadata = lstatSync(sourcePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("installation source must be a regular file");
  const installationPrefix = canonicalInstallPrefix(prefix, platform);
  const executableName = platform === "win32" ? "continuitydb.exe" : "continuitydb";
  const versionDirectory = join(installationPrefix, "lib", "continuitydb", version);
  const versionedBinary = join(versionDirectory, executableName);
  const binDirectory = join(installationPrefix, "bin");
  const launcher = join(binDirectory, executableName);
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const pathConfigured = pathValue.split(pathDelimiter)
    .some((item) => sameCanonicalPath(canonicalInstallPrefix(item || ".", platform), binDirectory, platform));
  const plan = {
    prefix: installationPrefix,
    source: sourcePath,
    versioned_binary: versionedBinary,
    launcher,
    ...installGuidance({ binDirectory, pathConfigured, platform }),
  };
  if (!apply) return { installed: false, preview: true, ...plan };

  const releaseInstallLock = acquireFileLock(
    join(dirname(installationPrefix), `.${basename(installationPrefix)}.continuitydb-install.lock`),
    { timeoutMs: 120_000 },
  );
  try {
    assertNoSymlinkAncestors(installationPrefix);
  const originalVersioned = entrySnapshot(versionedBinary);
  const originalLauncher = entrySnapshot(launcher);
  if (existsSync(versionedBinary) && sha256(versionedBinary) !== sha256(sourcePath)) {
    throw new Error(`versioned installation already exists with different content: ${versionedBinary}`);
  }
  const managedRoot = join(installationPrefix, "lib", "continuitydb");
  const launcherManaged = originalLauncher.existed && (platform === "win32"
    ? originalLauncher.type === "file" && isManagedWindowsLauncher(launcher, managedRoot)
    : originalLauncher.type === "link" && isManagedLauncher(launcher, managedRoot));
  if (originalLauncher.existed && !launcherManaged && !force) {
    throw new Error(`refusing to replace existing launcher without --force: ${launcher}`);
  }

  const createdDirectories = [];
  let versionedExpected = originalVersioned;
  let launcherExpected = originalLauncher;
  let launcherBackup = null;
  try {
    for (const directory of [
      installationPrefix,
      join(installationPrefix, "lib"),
      join(installationPrefix, "lib", "continuitydb"),
      versionDirectory,
      binDirectory,
    ]) ensureDirectory(directory, createdDirectories);

    if (!originalVersioned.existed) {
      const temporary = join(versionDirectory, `.${executableName}.${process.pid}.${randomUUID()}.tmp`);
      copyFileSync(sourcePath, temporary);
      chmodSync(temporary, 0o755);
      renameSync(temporary, versionedBinary);
      versionedExpected = entrySnapshot(versionedBinary);
    }

    const launcherAlreadyCurrent = platform === "win32"
      ? originalLauncher.existed && originalLauncher.type === "file" && sha256(launcher) === sha256(versionedBinary)
      : originalLauncher.existed && originalLauncher.type === "link"
        && resolve(dirname(launcher), originalLauncher.target) === versionedBinary;
    if (launcherAlreadyCurrent) {
      return { installed: true, preview: false, ...plan, sha256: sha256(versionedBinary), launcher_backup: null };
    }

    if (originalLauncher.existed) {
      if (!launcherManaged) launcherBackup = backupLauncher(launcher, installationPrefix, createdDirectories);
      unlinkSync(launcher);
      launcherExpected = entrySnapshot(launcher);
    }

    if (_testBeforeLauncherCommit) {
      if (process.env.NODE_ENV !== "test") throw new Error("installer test hook is available only in tests");
      _testBeforeLauncherCommit({ launcher, versionedBinary });
    }

    if (platform === "win32") {
      const temporary = join(binDirectory, `.${executableName}.${process.pid}.${randomUUID()}.tmp`);
      copyFileSync(versionedBinary, temporary);
      renameSync(temporary, launcher);
    } else {
      const temporary = join(binDirectory, `.continuitydb.${process.pid}.${randomUUID()}.link`);
      symlinkSync(relative(binDirectory, versionedBinary), temporary);
      renameSync(temporary, launcher);
    }
    launcherExpected = entrySnapshot(launcher);
  } catch (error) {
    const rollbackErrors = [];
    try { restoreEntry(launcher, originalLauncher, launcherExpected); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { restoreEntry(versionedBinary, originalVersioned, versionedExpected); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (launcherBackup?.created && existsSync(launcherBackup.path)) {
      try { unlinkSync(launcherBackup.path); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    try { removeCreatedDirectories(createdDirectories); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "standalone installation failed and rollback was incomplete");
    }
    throw error;
  }
    return { installed: true, preview: false, ...plan, sha256: sha256(versionedBinary), launcher_backup: launcherBackup?.path || null };
  } finally {
    releaseInstallLock();
  }
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
