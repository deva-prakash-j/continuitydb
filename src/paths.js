import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDataHome(environment = process.env, platform = process.platform) {
  if (environment.CONTINUITYDB_HOME) return resolve(environment.CONTINUITYDB_HOME);
  if (environment.CONTEXT_VAULT_HOME) return resolve(environment.CONTEXT_VAULT_HOME);
  if (platform === "win32") return resolve(environment.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ContinuityDB", "data");
  if (platform === "darwin") return resolve(homedir(), "Library", "Application Support", "ContinuityDB");
  return resolve(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "continuitydb");
}

export function hasPrivateDirectoryPermissions(mode, platform = process.platform) {
  // Windows ACLs are not represented by POSIX permission bits. Treat the mode
  // check as not applicable there and rely on the platform ACL instead.
  return platform === "win32" || (mode & 0o077) === 0;
}
