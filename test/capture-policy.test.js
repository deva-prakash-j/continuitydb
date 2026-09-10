import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapturePolicy, loadCapturePolicy } from "../src/capture-policy.js";
import { normalizeIdentity } from "../src/security.js";
import { ContextVault } from "../src/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-capture-test-"));
  const vault = new ContextVault(join(root, "vault"));
  const identity = normalizeIdentity({
    tenant_id: "tenant-a",
    principal_id: "agent-principal-a",
    owner_id: "deva",
    agent_id: "coding-agent-a",
    scopes: ["memory:read", "memory:capture", "memory:feedback"],
    allowed_projects: ["api"],
    allowed_sensitivities: ["private", "sensitive"],
  });
  return { root, vault, identity };
}

test("working capture auto-activates with bounded TTL and transfers across agents sharing an owner", () => {
  const f = fixture();
  try {
    const policy = new CapturePolicy(loadCapturePolicy(null));
    const assessment = policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      body: "Regenerate the API client after publishing the schema.",
      ttl_seconds: 9_999_999,
      repo_path: "auth.js",
      git_commit: "deadbeef",
      branch: "main",
      symbol: "forged",
    }, f.identity, f.vault);
    const result = f.vault.capture(assessment, { actor: f.identity.principal_id });
    assert.equal(result.disposition, "active");
    assert.equal(result.record.owner_id, "deva");
    assert.equal(result.record.agent_id, "coding-agent-a");
    assert.equal(result.record.repo_path, null);
    assert.equal(result.record.git_commit, null);
    assert.equal(result.record.branch, "main");
    assert.equal(result.record.symbol, null);
    assert.ok(Date.parse(result.record.expires_at) <= Date.now() + 86_401_000);
    assert.equal(f.vault.search({
      query: "schema",
      project_id: "api",
      tenant_id: "tenant-a",
      owner_id: "deva",
      allowed_projects: ["api"],
    }).length, 0);
    assert.equal(f.vault.search({
      query: "schema",
      project_id: "api",
      branch: "main",
      tenant_id: "tenant-a",
      owner_id: "deva",
      allowed_projects: ["api"],
    }).length, 1);
    assert.equal(f.vault.search({
      query: "schema",
      project_id: "api",
      tenant_id: "tenant-a",
      owner_id: "someone-else",
      allowed_projects: ["api"],
    }).length, 0);
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("risk policy holds decisions and conflicts out of recall", () => {
  const f = fixture();
  try {
    const policy = new CapturePolicy(loadCapturePolicy(null));
    const decision = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "decision",
      body: "We will migrate the API tomorrow.",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(decision.disposition, "proposed");
    const subjectlessInference = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "inference",
      confidence: 0.9,
      body: "A high-confidence claim without a stable subject.",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(subjectlessInference.disposition, "proposed");

    const first = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      subject_key: "api.release.order",
      body: "Publish schema before API.",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(first.disposition, "active");
    const conflict = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      subject_key: "api.release.order",
      body: "Publish API before schema.",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(conflict.disposition, "quarantined");
    assert.equal(f.vault.get(conflict.record.id), null);
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Git facts activate only when commit, reachable path, and checksum verify", () => {
  const f = fixture();
  const repo = join(f.root, "repo");
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
    const contents = "export const schemaVersion = 2;\n";
    writeFileSync(join(repo, "schema.js"), contents);
    execFileSync("git", ["add", "schema.js"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim();
    const checksum = createHash("sha256").update(contents).digest("hex");
    const configPath = join(f.root, "capture-policy.json");
    writeFileSync(configPath, JSON.stringify({ project_roots: { api: { root: repo, allowed_refs: ["HEAD"] } } }), { mode: 0o600 });
    const policy = new CapturePolicy(loadCapturePolicy(configPath));

    const unsupportedSummary = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "git-fact",
      confidence: 0.95,
      body: "The schema is guaranteed to remain backwards compatible.",
      repo_path: "schema.js",
      symbol: "unsupported-summary",
      git_commit: commit,
      content_checksum: checksum,
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(unsupportedSummary.disposition, "quarantined");

    const verified = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "git-fact",
      confidence: 0.95,
      body: "export const schemaVersion = 2;",
      repo_path: "schema.js",
      symbol: "NotInVerifiedExcerpt",
      git_commit: commit,
      branch,
      content_checksum: checksum,
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(verified.disposition, "active");
    assert.equal(verified.record.source_type, "git-verified-agent");
    assert.equal(verified.record.symbol, null);
    assert.equal(verified.record.branch, branch);
    assert.equal(verified.record.title, "schema.js");
    assert.match(verified.record.source_uri, /^git:\/\/api@/);

    const forgedBranch = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "git-fact",
      confidence: 0.95,
      body: "export const schemaVersion = 2;",
      repo_path: "schema.js",
      git_commit: commit,
      branch: "forged-main",
      content_checksum: checksum,
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(forgedBranch.disposition, "quarantined");

    const forged = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "git-fact",
      confidence: 0.95,
      body: "schemaVersion is 3.",
      repo_path: "schema.js",
      git_commit: commit,
      content_checksum: "0".repeat(64),
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(forged.disposition, "quarantined");
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("capture idempotency is scoped to the originating agent", () => {
  const f = fixture();
  try {
    const policy = new CapturePolicy(loadCapturePolicy(null));
    const first = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      body: "Agent A context.",
      idempotency_key: "turn-1",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    const secondIdentity = normalizeIdentity({
      ...f.identity,
      principal_id: "agent-principal-b",
      agent_id: "coding-agent-b",
    });
    const second = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      body: "Agent B context.",
      idempotency_key: "turn-1",
    }, secondIdentity, f.vault), { actor: secondIdentity.principal_id });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, false);
    assert.notEqual(first.record.id, second.record.id);
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("expired memory does not quarantine a fresh capture for the same subject", () => {
  const f = fixture();
  try {
    const expired = f.vault.propose({
      tenant_id: "tenant-a",
      owner_id: "deva",
      agent_id: "coding-agent-a",
      namespace_id: "project/api",
      project_id: "api",
      type: "working",
      subject_key: "api.current.release",
      body: "Release v1 is current.",
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    f.vault.commit(expired.record.id);
    const policy = new CapturePolicy(loadCapturePolicy(null));
    const fresh = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      subject_key: "api.current.release",
      body: "Release v2 is current.",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    assert.equal(fresh.disposition, "active");
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("recursive secret detection rejects nested metadata before persistence", () => {
  const f = fixture();
  try {
    assert.throws(() => f.vault.propose({
      tenant_id: "tenant-a",
      owner_id: "deva",
      namespace_id: "project/api",
      project_id: "api",
      body: "ordinary content",
      metadata: { nested: { api_key: `sk-${"x".repeat(32)}` } },
    }), /credential-like/);
    assert.throws(() => f.vault.propose({
      tenant_id: "tenant-a",
      owner_id: "deva",
      namespace_id: "project/api",
      project_id: "api",
      body: "ordinary content two",
      metadata: { nested: { password: "dummy-secret-value" } },
    }), /credential-like/);
    assert.deepEqual(f.vault.stats({ tenant_id: "tenant-a" }).records, {});
    assert.equal(f.vault.verifyAuditLog().events, 0);
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("feedback is unique per principal and cannot mutate memory lifecycle", () => {
  const f = fixture();
  try {
    const policy = new CapturePolicy(loadCapturePolicy(null));
    const active = f.vault.capture(policy.evaluate({
      project_id: "api",
      memory_kind: "working",
      body: "Retry only idempotent API requests.",
    }, f.identity, f.vault), { actor: f.identity.principal_id });
    f.vault.feedback({
      tenant_id: "tenant-a",
      owner_id: "deva",
      principal_id: "agent-principal-a",
      agent_id: "coding-agent-a",
      memory_id: active.record.id,
      signal: "helpful",
    });
    f.vault.feedback({
      tenant_id: "tenant-a",
      owner_id: "deva",
      principal_id: "agent-principal-a",
      agent_id: "coding-agent-a",
      memory_id: active.record.id,
      signal: "outdated",
    });
    const [result] = f.vault.search({
      query: "idempotent",
      project_id: "api",
      tenant_id: "tenant-a",
      owner_id: "deva",
      allowed_projects: ["api"],
    });
    assert.deepEqual(result.feedback, { helpful: 0, incorrect: 0, outdated: 1 });
    assert.equal(f.vault.get(active.record.id).status, "active");
  } finally {
    f.vault.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("capture policy rejects group-readable files and invalid numeric limits", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-capture-config-test-"));
  const path = join(root, "capture-policy.json");
  try {
    writeFileSync(path, JSON.stringify({ working_ttl_seconds: 3600 }), { mode: 0o644 });
    assert.throws(() => loadCapturePolicy(path), /must not be readable/);
    chmodSync(path, 0o600);
    assert.equal(loadCapturePolicy(path).working_ttl_seconds, 3600);
    writeFileSync(path, JSON.stringify({ working_ttl_seconds: "invalid" }), { mode: 0o600 });
    assert.throws(() => loadCapturePolicy(path), /finite number/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
