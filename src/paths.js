import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDataHome(environment = process.env, platform = process.platform) {
  if (environment.CONTINUITYDB_HOME) return resolve(environment.CONTINUITYDB_HOME);
  if (environment.CONTEXT_VAULT_HOME) return resolve(environment.CONTEXT_VAULT_HOME);
  if (platform === "win32") return resolve(environment.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ContinuityDB", "data");
  if (platform === "darwin") return resolve(homedir(), "Library", "Application Support", "ContinuityDB");
  return resolve(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "continuitydb");
}
