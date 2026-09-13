import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listRegisteredProjects, registerProject } from "../src/project-registry.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-project-registry-"));
  return {
    root,
    home: join(root, "vault"),
    identity: { id: "billing-api", root: join(root, "billing-api"), source: "git" },
  };
}

test("project registration previews without writing", () => {
  const { root, home, identity } = fixture();
  try {
    const result = registerProject(home, identity, { apply: false });
    assert.deepEqual(result, {
      changed: true,
      applied: false,
      projects: [identity],
    });
    assert.equal(existsSync(join(home, "config.json")), false);
    assert.equal(existsSync(home), false, "preview must not create the vault home");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration is idempotent and rejects one id at two roots", () => {
  const { root, home, identity } = fixture();
  const other = join(root, "other-billing-api");
  try {
    assert.equal(registerProject(home, identity, { apply: true }).changed, true);
    assert.equal(registerProject(home, identity, { apply: true }).changed, false);
    assert.throws(
      () => registerProject(home, { ...identity, root: other }, { apply: true }),
      /already registered/,
    );
    assert.deepEqual(listRegisteredProjects(home), [identity]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration preserves unknown config keys and writes config mode 0600", () => {
  const { root, home, identity } = fixture();
  const configPath = join(home, "config.json");
  try {
    const initialized = registerProject(home, { id: "existing", root: join(root, "existing"), source: "explicit" }, { apply: true });
    assert.equal(initialized.applied, true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.custom_extension = { enabled: true, nested: [1, 2, 3] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o644 });

    const result = registerProject(home, identity, { apply: true });
    assert.equal(result.changed, true);
    assert.equal(result.applied, true);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(written.custom_extension, { enabled: true, nested: [1, 2, 3] });
    assert.deepEqual(written.projects, [
      { id: "existing", root: join(root, "existing"), source: "explicit" },
      identity,
    ]);
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listing a missing registry is read-only and invalid registries fail closed", () => {
  const { root, home } = fixture();
  try {
    assert.deepEqual(listRegisteredProjects(home), []);
    assert.equal(existsSync(home), false);
    registerProject(home, { id: "valid", root: join(root, "valid"), source: "explicit" }, { apply: true });
    writeFileSync(join(home, "config.json"), '{"projects":"all"}\n');
    assert.throws(() => listRegisteredProjects(home), /projects.*array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stored project ID registered at two roots fails closed", () => {
  const { root, home } = fixture();
  try {
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), `${JSON.stringify({
      projects: [
        { id: "AgentForge", root: join(root, "AgentForge"), source: "git" },
        { id: "AgentForge", root: join(root, "other-AgentForge"), source: "explicit" },
      ],
    })}\n`, { mode: 0o600 });
    assert.throws(() => listRegisteredProjects(home), /project AgentForge.*more than once|duplicate.*AgentForge/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stored project root registered under two IDs fails closed", () => {
  const { root, home } = fixture();
  const shared = join(root, "shared");
  try {
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), `${JSON.stringify({
      projects: [
        { id: "service", root: shared, source: "git" },
        { id: "service-copy", root: shared, source: "git" },
      ],
    })}\n`, { mode: 0o600 });
    assert.throws(() => listRegisteredProjects(home), /root .*registered more than once/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
