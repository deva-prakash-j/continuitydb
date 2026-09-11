import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { validateReleaseWorkflow } from "../scripts/validate-release-workflow.js";

const workflow = parse(readFileSync(new URL("../.github/workflows/release-binaries.yml", import.meta.url), "utf8"));

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
