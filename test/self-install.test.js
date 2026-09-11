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

test("standalone installer rolls back a failed fresh installation", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-self-install-fresh-rollback-"));
  const source = join(root, "downloaded-continuitydb");
  const prefix = join(root, "prefix");
  const previousNodeEnv = process.env.NODE_ENV;
  writeFileSync(source, "binary-fixture", { mode: 0o755 });
  try {
    process.env.NODE_ENV = "test";
    assert.throws(
      () => installStandaloneBinary({
        source,
        prefix,
        standalone: true,
        platform: "linux",
        version: "9.9.9",
        apply: true,
        _testBeforeLauncherCommit: () => { throw new Error("forced launcher failure"); },
      }),
      /forced launcher failure/,
    );
    assert.equal(existsSync(prefix), false, "failed fresh install must remove every path it created");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone installer restores an unmanaged launcher after a failed forced upgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-self-install-upgrade-rollback-"));
  const source = join(root, "downloaded-continuitydb");
  const prefix = join(root, "prefix");
  const launcher = join(prefix, "bin", "continuitydb");
  const nextVersion = join(prefix, "lib", "continuitydb", "10.0.0", "continuitydb");
  const previousNodeEnv = process.env.NODE_ENV;
  writeFileSync(source, "binary-fixture", { mode: 0o755 });
  try {
    process.env.NODE_ENV = "test";
    installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true });
    rmSync(launcher);
    writeFileSync(launcher, "unmanaged-before-upgrade", { mode: 0o755 });

    assert.throws(
      () => installStandaloneBinary({
        source,
        prefix,
        standalone: true,
        platform: "linux",
        version: "10.0.0",
        apply: true,
        force: true,
        _testBeforeLauncherCommit: () => { throw new Error("forced upgrade failure"); },
      }),
      /forced upgrade failure/,
    );
    assert.equal(readFileSync(launcher, "utf8"), "unmanaged-before-upgrade");
    assert.equal(existsSync(nextVersion), false, "failed upgrade must remove its newly copied version");
    assert.equal(
      existsSync(join(prefix, "lib", "continuitydb", "backups")),
      false,
      "failed upgrade must remove backup artifacts and directories it created",
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone installer preserves a concurrent launcher writer during rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-self-install-concurrent-rollback-"));
  const source = join(root, "downloaded-continuitydb");
  const prefix = join(root, "prefix");
  const launcher = join(prefix, "bin", "continuitydb");
  const previousNodeEnv = process.env.NODE_ENV;
  writeFileSync(source, "binary-fixture", { mode: 0o755 });
  try {
    process.env.NODE_ENV = "test";
    installStandaloneBinary({ source, prefix, standalone: true, platform: "linux", version: "9.9.9", apply: true });
    rmSync(launcher);
    writeFileSync(launcher, "unmanaged-before-upgrade", { mode: 0o755 });

    assert.throws(
      () => installStandaloneBinary({
        source,
        prefix,
        standalone: true,
        platform: "linux",
        version: "10.0.0",
        apply: true,
        force: true,
        _testBeforeLauncherCommit: () => {
          writeFileSync(launcher, "concurrent-launcher", { mode: 0o755 });
          throw new Error("forced concurrent failure");
        },
      }),
      (error) => error instanceof AggregateError
        && error.errors.some((item) => /rollback conflict: installation target changed concurrently/.test(item.message)),
    );
    assert.equal(readFileSync(launcher, "utf8"), "concurrent-launcher");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
