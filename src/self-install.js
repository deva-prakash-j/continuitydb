import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, parse, relative, resolve, sep } from "node:path";
import { defaultInstallPrefix } from "./agent-connectors.js";
import { isStandaloneBinary } from "./binary-runtime.js";
import { VERSION } from "./version.js";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureDirectory(path) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`installation path must be a real directory: ${path}`);
  } else mkdirSync(path, { recursive: true, mode: 0o700 });
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

function isManagedLauncher(path, managedRoot) {
  if (!lstatSync(path).isSymbolicLink()) return false;
  const target = resolve(dirname(path), readlinkSync(path));
  const value = relative(managedRoot, target);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function backupLauncher(path, installationPrefix) {
  const directory = join(installationPrefix, "lib", "continuitydb", "backups");
  ensureDirectory(directory);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    const target = readlinkSync(path);
    const destination = join(directory, `launcher-${sha256Text(target).slice(0, 16)}.link.txt`);
    if (!existsSync(destination)) writeFilePrivate(destination, `${target}\n`);
    return destination;
  }
  if (!metadata.isFile()) throw new Error(`existing launcher is not a regular file or symlink: ${path}`);
  const destination = join(directory, `launcher-${sha256(path).slice(0, 16)}.bak`);
  if (!existsSync(destination)) {
    copyFileSync(path, destination);
    chmodSync(destination, 0o600);
  }
  return destination;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFilePrivate(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
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
} = {}) {
  if (!standalone) throw new Error("self-install is available only from a standalone ContinuityDB binary");
  const sourcePath = realpathSync(source);
  const metadata = lstatSync(sourcePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("installation source must be a regular file");
  const installationPrefix = resolve(prefix);
  const executableName = platform === "win32" ? "continuitydb.exe" : "continuitydb";
  const versionDirectory = join(installationPrefix, "lib", "continuitydb", version);
  const versionedBinary = join(versionDirectory, executableName);
  const binDirectory = join(installationPrefix, "bin");
  const launcher = join(binDirectory, executableName);
  const pathConfigured = pathValue.split(delimiter).some((item) => resolve(item || ".") === binDirectory);
  const plan = { prefix: installationPrefix, source: sourcePath, versioned_binary: versionedBinary, launcher, path_configured: pathConfigured };
  if (!apply) return { installed: false, preview: true, ...plan };

  assertNoSymlinkAncestors(installationPrefix);
  ensureDirectory(installationPrefix);
  ensureDirectory(join(installationPrefix, "lib"));
  ensureDirectory(join(installationPrefix, "lib", "continuitydb"));
  ensureDirectory(versionDirectory);
  ensureDirectory(binDirectory);
  if (existsSync(versionedBinary) && sha256(versionedBinary) !== sha256(sourcePath)) {
    throw new Error(`versioned installation already exists with different content: ${versionedBinary}`);
  }
  if (!existsSync(versionedBinary)) {
    const temporary = join(versionDirectory, `.${executableName}.${process.pid}.${randomUUID()}.tmp`);
    copyFileSync(sourcePath, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, versionedBinary);
  }

  let launcherBackup = null;
  if (platform === "win32") {
    if (existsSync(launcher) && sha256(launcher) === sha256(versionedBinary)) {
      return { installed: true, preview: false, ...plan, sha256: sha256(versionedBinary), launcher_backup: null };
    }
    if (existsSync(launcher)) {
      if (!force) throw new Error(`refusing to replace existing launcher without --force: ${launcher}`);
      launcherBackup = backupLauncher(launcher, installationPrefix);
      unlinkSync(launcher);
    }
    const temporary = join(binDirectory, `.${executableName}.${process.pid}.${randomUUID()}.tmp`);
    copyFileSync(versionedBinary, temporary);
    renameSync(temporary, launcher);
  } else {
    if (existsSync(launcher) || lstatSafe(launcher)) {
      const managed = isManagedLauncher(launcher, join(installationPrefix, "lib", "continuitydb"));
      if (!managed && !force) throw new Error(`refusing to replace existing launcher without --force: ${launcher}`);
      if (!managed) launcherBackup = backupLauncher(launcher, installationPrefix);
      unlinkSync(launcher);
    }
    const temporary = join(binDirectory, `.continuitydb.${process.pid}.${randomUUID()}.link`);
    symlinkSync(relative(binDirectory, versionedBinary), temporary);
    renameSync(temporary, launcher);
  }
  return { installed: true, preview: false, ...plan, sha256: sha256(versionedBinary), launcher_backup: launcherBackup };
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
