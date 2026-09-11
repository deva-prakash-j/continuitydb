import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { defaultDataHome, hasPrivateDirectoryPermissions } from "../src/paths.js";

test("default data home is global and honors explicit environment overrides", () => {
  assert.equal(defaultDataHome({ CONTINUITYDB_HOME: "/srv/continuity" }, "linux"), resolve("/srv/continuity"));
  assert.equal(defaultDataHome({ XDG_DATA_HOME: "/data" }, "linux"), resolve("/data", "continuitydb"));
  assert.equal(defaultDataHome({ LOCALAPPDATA: "/windows-data" }, "win32"), resolve("/windows-data", "ContinuityDB", "data"));
  assert.equal(defaultDataHome({}, "linux").endsWith(join(".local", "share", "continuitydb")), true);
  assert.equal(defaultDataHome({}, "darwin").endsWith(join("Library", "Application Support", "ContinuityDB")), true);
});

test("private directory permission checks are POSIX-only", () => {
  assert.equal(hasPrivateDirectoryPermissions(0o700, "linux"), true);
  assert.equal(hasPrivateDirectoryPermissions(0o755, "linux"), false);
  assert.equal(hasPrivateDirectoryPermissions(0o755, "win32"), true);
});
