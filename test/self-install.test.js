import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalInstallPrefix, installStandaloneBinary } from "../src/self-install.js";

test("standalone installer canonicalizes only the trusted macOS /var alias", () => {
  assert.equal(canonicalInstallPrefix("/var/folders/example/prefix", "darwin"), "/private/var/folders/example/prefix");
  assert.equal(canonicalInstallPrefix("/var", "darwin"), "/private/var");
  assert.equal(canonicalInstallPrefix("/var/folders/example/prefix", "linux"), "/var/folders/example/prefix");
});

test("standalone installer previews, installs versioned binary, and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-self-install-"));
  const source = join(root, "downloaded-continuitydb");
  const prefix = join(root, "prefix");
  writeFileSync(source, "binary-fixture", { mode: 0o755 });
  try {
    const preview = installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9" });
    assert.equal(preview.preview, true);
    assert.equal(existsSync(preview.launcher), false);
    const installed = installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true });
    assert.equal(installed.installed, true);
    assert.equal(lstatSync(installed.launcher).isSymbolicLink(), true);
    assert.equal(readFileSync(installed.launcher, "utf8"), "binary-fixture");
    assert.doesNotThrow(() => installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone installer refuses to replace an unmanaged launcher", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-self-install-conflict-"));
  const source = join(root, "downloaded-continuitydb");
  const prefix = join(root, "prefix");
  writeFileSync(source, "binary-fixture", { mode: 0o755 });
  try {
    installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true });
    rmSync(join(prefix, "bin", "continuitydb"));
    writeFileSync(join(prefix, "bin", "continuitydb"), "unmanaged");
    assert.throws(
      () => installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true }),
      /refusing to replace existing launcher/,
    );
    const forced = installStandaloneBinary({
      source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true, force: true,
    });
    assert.equal(existsSync(forced.launcher_backup), true);
    assert.equal(readFileSync(forced.launcher_backup, "utf8"), "unmanaged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
