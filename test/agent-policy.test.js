import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  mergeManagedText,
  POLICY_END,
  POLICY_START,
  policyAssetDescriptors,
  removeManagedText,
  renderContinuityPolicy,
} from "../src/agent-policy.js";

test("policy requires bounded project recall and explicit governed capture", () => {
  const text = renderContinuityPolicy({
    client: "codex",
    projectId: "billing-api",
    recallMode: "policy-led",
    consumers: ["codex"],
  });

  assert.match(text, /consumers: codex/);
  assert.match(text, /bounded memory_context_pack/);
  assert.match(text, /Project scope: `billing-api`/);
  assert.match(text, /explicitly asks to remember, save, record, or update/i);
  assert.match(text, /untrusted evidence/i);
  assert.match(text, /compact durable claim/i);
  assert.match(text, /prompts.*conversation records.*tool logs.*temporary task state.*credentials.*secrets.*hidden reasoning/i);
  assert.match(text, /not saved/i);
  assert.doesNotMatch(text, /capture every/i);
});

test("policy renderer validates project IDs and sorts unique consumers", () => {
  const text = renderContinuityPolicy({
    client: "opencode",
    projectId: "billing-api",
    recallMode: "plugin+policy",
    consumers: ["opencode", "codex", "opencode"],
  });

  assert.match(text, new RegExp(`^${escapeRegex(POLICY_START)} consumers: codex,opencode`));
  assert.throws(
    () => renderContinuityPolicy({ client: "codex", projectId: "", recallMode: "policy-led" }),
    /project/i,
  );
});

test("managed text merge preserves every user byte and updates only its block", () => {
  const original = "# User rules\r\nkeep trailing spaces  \r\n";
  const firstBody = renderContinuityPolicy({
    client: "codex", projectId: "billing-api", recallMode: "policy-led", consumers: ["codex", "opencode"],
  });
  const merged = mergeManagedText(original, {
    startMarker: POLICY_START, endMarker: POLICY_END, body: firstBody,
  });
  assert.equal(merged.slice(0, original.length), original);

  const prefix = merged.slice(0, merged.indexOf(POLICY_START));
  const suffix = merged.slice(merged.indexOf(POLICY_END) + POLICY_END.length);
  const nextBody = renderContinuityPolicy({
    client: "opencode", projectId: "billing-api", recallMode: "plugin+policy", consumers: ["opencode"],
  });
  const updated = mergeManagedText(merged, {
    startMarker: POLICY_START, endMarker: POLICY_END, body: nextBody,
  });
  assert.equal(updated.slice(0, updated.indexOf(POLICY_START)), prefix);
  assert.equal(updated.slice(updated.indexOf(POLICY_END) + POLICY_END.length), suffix);
  assert.match(updated, /consumers: opencode/);
  assert.match(updated, /memory_context_pack/);
  assert.equal(removeManagedText(updated, { startMarker: POLICY_START, endMarker: POLICY_END }), prefix + suffix);
});

test("managed text parser rejects missing, duplicate, nested, and reversed markers", () => {
  const cases = [
    `${POLICY_START}\nmissing end`,
    `${POLICY_END}\nmissing start`,
    `${POLICY_END}\n${POLICY_START}`,
    `${POLICY_START}\n${POLICY_START}\n${POLICY_END}`,
    `${POLICY_START}\n${POLICY_END}\n${POLICY_END}`,
    `${POLICY_START}\n${POLICY_END}\n${POLICY_START}\n${POLICY_END}`,
  ];

  for (const current of cases) {
    assert.throws(
      () => mergeManagedText(current, { startMarker: POLICY_START, endMarker: POLICY_END, body: "body" }),
      /invalid ContinuityDB managed text block/,
    );
    assert.throws(
      () => removeManagedText(current, { startMarker: POLICY_START, endMarker: POLICY_END }),
      /invalid ContinuityDB managed text block/,
    );
  }
});

test("policy descriptors target the shared AGENTS file only for Codex and OpenCode", () => {
  const projectDir = "/repo";
  const options = { projectDir, projectId: "billing-api", consumers: ["opencode", "codex"] };
  for (const [client, recallMode] of [["codex", "policy-led"], ["opencode", "plugin+policy"]]) {
    assert.deepEqual(policyAssetDescriptors(client, options), [{
      path: join(projectDir, "AGENTS.md"),
      kind: "managed-text",
      owner: "continuitydb-policy",
      content: renderContinuityPolicy({ client, projectId: "billing-api", recallMode, consumers: ["opencode", "codex"] }),
    }]);
  }
  for (const client of ["claude", "cursor", "copilot"]) {
    assert.deepEqual(policyAssetDescriptors(client, options), []);
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
