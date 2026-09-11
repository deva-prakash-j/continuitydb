import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { validateCiWorkflow, validateReleaseWorkflow } from "../scripts/validate-release-workflow.js";

const workflow = parse(readFileSync(new URL("../.github/workflows/release-binaries.yml", import.meta.url), "utf8"));
const ciWorkflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const packageDocument = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("release workflow blocks publication on post-sign native semantic verification", () => {
  assert.equal(validateReleaseWorkflow(workflow).valid, true);
});

test("release workflow validator rejects missing, skipped, or misordered semantic gates", () => {
  const missing = structuredClone(workflow);
  missing.jobs.build.steps = missing.jobs.build.steps.filter((step) => step.run !== "npm run smoke:binary:semantic");
  assert.throws(() => validateReleaseWorkflow(missing), /semantic inference is missing/);

  const skipped = structuredClone(workflow);
  skipped.jobs.build.steps.find((step) => step.run === "npm run smoke:binary:semantic").if = "runner.os == 'Linux'";
  assert.throws(() => validateReleaseWorkflow(skipped), /must run for every native matrix target/);

  const beforeSigning = structuredClone(workflow);
  const steps = beforeSigning.jobs.build.steps;
  const semantic = steps.splice(steps.findIndex((step) => step.run === "npm run smoke:binary:semantic"), 1)[0];
  steps.splice(steps.findIndex((step) => String(step.run || "").includes("codesign")), 0, semantic);
  assert.throws(() => validateReleaseWorkflow(beforeSigning), /semantic inference is missing or misordered/);

  const independentPublish = structuredClone(workflow);
  independentPublish.jobs.publish.needs = [];
  assert.throws(() => validateReleaseWorkflow(independentPublish), /publish must depend/);
});

test("release workflow rejects mutable action tags in privileged and build jobs", () => {
  for (const [job, action] of [["build", "actions/checkout@v5"], ["publish", "actions/download-artifact@v5"]]) {
    const mutable = structuredClone(workflow);
    mutable.jobs[job].steps.find((step) => step.uses).uses = action;
    assert.throws(() => validateReleaseWorkflow(mutable), /full immutable commit SHA/);
  }
});

test("CI uploads only an immutable, semantically verified native binary", () => {
  assert.equal(validateCiWorkflow(ciWorkflow).valid, true);

  const missingSemantic = structuredClone(ciWorkflow);
  missingSemantic.jobs.binary.steps = missingSemantic.jobs.binary.steps
    .filter((step) => step.run !== "npm run smoke:binary:semantic");
  assert.throws(() => validateCiWorkflow(missingSemantic), /semantic inference is missing/);

  const earlyUpload = structuredClone(ciWorkflow);
  const steps = earlyUpload.jobs.binary.steps;
  const upload = steps.splice(steps.findIndex((step) => String(step.uses || "").startsWith("actions/upload-artifact@")), 1)[0];
  steps.splice(steps.findIndex((step) => step.run === "npm run smoke:binary:semantic"), 0, upload);
  assert.throws(() => validateCiWorkflow(earlyUpload), /post-verification bytes/);

  const mutableUpload = structuredClone(ciWorkflow);
  mutableUpload.jobs.binary.steps.find((step) => String(step.uses || "").startsWith("actions/upload-artifact@")).uses = "actions/upload-artifact@v4";
  assert.throws(() => validateCiWorkflow(mutableUpload), /full immutable commit SHA/);
});

test("release check builds the standalone binary before the generated Codex config probe", () => {
  assert.equal(packageDocument.scripts["test:codex-config"], "npm run test:codex-generated-config");
  assert.equal(
    packageDocument.scripts["test:codex-generated-config"],
    "npm run build:binary && node scripts/codex-generated-config-probe.js",
  );
  assert.match(packageDocument.scripts["release:check"], /npm run test:codex-config$/);
});
