import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ContextVault } from "../src/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "context-vault-test-"));
  const vault = new ContextVault(root);
  return {
    root,
    vault,
    cleanup() {
      vault.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("proposals are invisible until committed and retries are idempotent", () => {
  const f = fixture();
  try {
    const first = f.vault.propose({
      body: "The billing service uses the outbox pattern for Kafka publication.",
      namespace_id: "project/billing-service",
      project_id: "billing-service",
      idempotency_key: "billing-outbox-v1",
    });
    assert.equal(f.vault.search({
      query: "Kafka outbox",
      project_id: "billing-service",
      allowed_projects: ["billing-service"],
    }).length, 0);

    const retry = f.vault.propose({
      body: "This retry body must not create another memory.",
      namespace_id: "project/billing-service",
      idempotency_key: "billing-outbox-v1",
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.record.id, first.record.id);

    const otherProject = f.vault.propose({
      body: "The same client key can be reused safely in another project namespace.",
      namespace_id: "project/schema-service",
      project_id: "schema-service",
      idempotency_key: "billing-outbox-v1",
    });
    assert.equal(otherProject.duplicate, false);
    assert.notEqual(otherProject.record.id, first.record.id);

    f.vault.commit(first.record.id);
    const results = f.vault.search({
      query: "Kafka outbox",
      project_id: "billing-service",
      allowed_projects: ["billing-service"],
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, first.record.id);
  } finally {
    f.cleanup();
  }
});

test("a project sees explicit dependencies but not unrelated projects", () => {
  const f = fixture();
  try {
    const shared = f.vault.propose({
      body: "Changing ChargeSchema requires regenerating downstream Java clients.",
      namespace_id: "project/charge-schema",
      project_id: "charge-schema",
      symbol: "ChargeSchema",
      git_commit: "abc123",
    });
    f.vault.commit(shared.record.id);

    const unrelated = f.vault.propose({
      body: "ChargeSchema is mentioned in an unrelated sandbox.",
      namespace_id: "project/sandbox",
      project_id: "sandbox",
    });
    f.vault.commit(unrelated.record.id);

    f.vault.linkProjects({
      source_project: "charge-api",
      target_project: "charge-schema",
      provenance: "charge-api/pom.xml declares charge-schema",
    });

    const results = f.vault.search({
      query: "ChargeSchema",
      project_id: "charge-api",
      allowed_projects: ["charge-api", "charge-schema"],
    });
    assert.deepEqual(results.map((item) => item.id), [shared.record.id]);
  } finally {
    f.cleanup();
  }
});

test("forget removes a memory from recall and canonical data rebuilds the index", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      body: "Run ./gradlew contractTest before publishing the shared client.",
      namespace_id: "personal/global",
    });
    f.vault.commit(proposal.record.id);
    assert.equal(f.vault.search({ query: "contractTest" }).length, 1);

    assert.equal(f.vault.rebuildIndex().records, 1);
    assert.equal(f.vault.search({ query: "contractTest" }).length, 1);

    const forgotten = f.vault.forget(proposal.record.id);
    assert.equal(forgotten.recoverable, true);
    assert.equal(f.vault.search({ query: "contractTest" }).length, 0);
  } finally {
    f.cleanup();
  }
});

test("owner, sensitivity and project allowlists are enforced before retrieval", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      owner_id: "office-user",
      body: "InternalLedger rotates signing material through the corporate key service.",
      namespace_id: "project/ledger-private",
      project_id: "ledger-private",
      sensitivity: "sensitive",
    });
    f.vault.commit(proposal.record.id);

    assert.throws(
      () => f.vault.search({
        query: "InternalLedger",
        project_id: "ledger-private",
        owner_id: "local-user",
        allowed_projects: [],
      }),
      /not allowed/,
    );
    assert.equal(f.vault.search({
      query: "InternalLedger",
      project_id: "ledger-private",
      owner_id: "local-user",
      allowed_projects: ["ledger-private"],
      allowed_sensitivities: ["public", "private", "sensitive"],
    }).length, 0);
    assert.equal(f.vault.search({
      query: "InternalLedger",
      project_id: "ledger-private",
      owner_id: "office-user",
      allowed_projects: ["ledger-private"],
      allowed_sensitivities: ["public", "private"],
    }).length, 0);
    assert.equal(f.vault.search({
      query: "InternalLedger",
      project_id: "ledger-private",
      owner_id: "office-user",
      allowed_projects: ["ledger-private"],
      allowed_sensitivities: ["sensitive"],
    }).length, 1);
  } finally {
    f.cleanup();
  }
});

test("credential-like content is rejected before canonical or indexed storage", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.vault.propose({ body: `api_key=${"sk-"}${"x".repeat(32)}` }),
      /credential-like content is prohibited/,
    );
    assert.equal(f.vault.exportJsonl(), "");
  } finally {
    f.cleanup();
  }
});

test("same-body corrections create a new active version and supersede the old one", () => {
  const f = fixture();
  try {
    const proposal = f.vault.propose({
      body: "Use Java 21 for new platform services.",
      namespace_id: "personal/global",
      confidence: 0.7,
    });
    f.vault.commit(proposal.record.id);
    const corrected = f.vault.correct(proposal.record.id, {
      body: "Use Java 21 for new platform services.",
      confidence: 1,
    }, "confidence-confirmed");

    assert.notEqual(corrected.id, proposal.record.id);
    assert.equal(corrected.status, "active");
    assert.equal(f.vault.get(proposal.record.id, { includeInactive: true }).status, "superseded");
    const results = f.vault.search({ query: "Java 21 platform services" });
    assert.deepEqual(results.map((item) => item.id), [corrected.id]);
  } finally {
    f.cleanup();
  }
});

test("v0.2 SQLite schema upgrades before subject indexes are created", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-upgrade-test-"));
  try {
    const initial = new ContextVault(root);
    initial.close();
    const database = new DatabaseSync(join(root, "index", "context-vault.db"));
    database.exec("DROP INDEX IF EXISTS idx_memory_subject; ALTER TABLE memory_records DROP COLUMN subject_key;");
    database.close();

    const upgraded = new ContextVault(root);
    const columns = upgraded.db.prepare("PRAGMA table_info(memory_records)").all().map((row) => row.name);
    assert.equal(columns.includes("subject_key"), true);
    const indexes = upgraded.db.prepare("PRAGMA index_list(memory_records)").all().map((row) => row.name);
    assert.equal(indexes.includes("idx_memory_subject"), true);
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
