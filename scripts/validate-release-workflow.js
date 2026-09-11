#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

function invariant(condition, message) {
  if (!condition) throw new Error(`release workflow invariant failed: ${message}`);
}

function runIndex(steps, command) {
  return steps.findIndex((step) => String(step.run || "").trim() === command);
}

function actionIndex(steps, prefix) {
  return steps.findIndex((step) => String(step.uses || "").startsWith(prefix));
}

function validatePinnedActions(steps) {
  for (const step of steps) {
    if (!step.uses) continue;
    invariant(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(String(step.uses)),
      `third-party action must use a full immutable commit SHA: ${step.uses}`);
  }
}

export function validateReleaseWorkflow(document) {
  invariant(document?.on?.pull_request !== undefined,
    "pull_request trigger is required so native release gates run before merge");
  const build = document?.jobs?.build;
  const publish = document?.jobs?.publish;
  invariant(build && publish, "build and publish jobs are required");
  invariant(build.strategy?.["fail-fast"] === false, "all native targets must complete even if one fails");
  const targets = build.strategy?.matrix?.include || [];
  const names = new Set(targets.map((target) => target.name));
  for (const required of ["linux-x64", "macos-x64", "macos-arm64", "windows-x64"]) {
    invariant(names.has(required), `native target ${required} is missing`);
  }
  const targetByName = new Map(targets.map((target) => [target.name, target]));
  invariant(targetByName.get("macos-x64")?.os === "macos-15-intel",
    "macos-x64 must use the supported macos-15-intel runner");
  invariant(targetByName.get("macos-arm64")?.os === "macos-15",
    "macos-arm64 must use the supported macos-15 runner");

  const steps = build.steps || [];
  validatePinnedActions(steps);
  const buildIndex = runIndex(steps, "npm run build:binary");
  const signIndex = steps.findIndex((step) => String(step.run || "").includes("codesign --force --sign"));
  const smokeIndex = runIndex(steps, "npm run smoke:binary");
  const semanticIndex = runIndex(steps, "npm run smoke:binary:semantic");
  const checksumIndex = runIndex(steps, "npm run checksum:binaries");
  const uploadIndex = actionIndex(steps, "actions/upload-artifact@");
  invariant(buildIndex >= 0, "standalone binary build is missing");
  invariant(signIndex > buildIndex, "macOS signing must occur after build");
  invariant(smokeIndex > signIndex, "post-sign binary smoke is missing or misordered");
  invariant(semanticIndex > smokeIndex, "post-sign native semantic inference is missing or misordered");
  invariant(checksumIndex > semanticIndex, "checksums must be created only after semantic verification");
  invariant(uploadIndex > checksumIndex, "only post-verification bytes may be uploaded");
  for (const index of [smokeIndex, semanticIndex, checksumIndex, uploadIndex]) {
    invariant(!steps[index].if, "verification/checksum/upload gates must run for every native matrix target");
    invariant(steps[index]["continue-on-error"] !== true, "native release gates must be blocking");
  }

  const needs = Array.isArray(publish.needs) ? publish.needs : [publish.needs];
  invariant(needs.includes("build"), "publish must depend on every native build matrix result");
  const publishSteps = publish.steps || [];
  validatePinnedActions(publishSteps);
  const downloadIndex = actionIndex(publishSteps, "actions/download-artifact@");
  const attestIndex = actionIndex(publishSteps, "actions/attest-build-provenance@");
  const releaseIndex = publishSteps.findIndex((step) => String(step.run || "").includes("gh release create"));
  invariant(downloadIndex >= 0 && attestIndex > downloadIndex && releaseIndex > attestIndex,
    "downloaded native artifacts must be attested before release publication");
  return { valid: true, native_targets: [...names].sort() };
}

export function validateCiWorkflow(document) {
  const jobs = document?.jobs || {};
  invariant(jobs.binary, "CI binary job is required");
  for (const job of Object.values(jobs)) validatePinnedActions(job.steps || []);
  const steps = jobs.binary.steps || [];
  const functionalIndex = runIndex(steps, "npm run test:binary");
  const semanticIndex = runIndex(steps, "npm run smoke:binary:semantic");
  const checksumIndex = runIndex(steps, "npm run checksum:binaries");
  const uploadIndex = actionIndex(steps, "actions/upload-artifact@");
  invariant(functionalIndex >= 0, "CI standalone binary test is missing");
  invariant(semanticIndex > functionalIndex, "CI native semantic inference is missing or misordered");
  invariant(checksumIndex > semanticIndex, "CI checksums must follow semantic verification");
  invariant(uploadIndex > checksumIndex, "CI may upload only post-verification bytes");
  for (const index of [functionalIndex, semanticIndex, checksumIndex, uploadIndex]) {
    invariant(!steps[index].if, "CI binary verification/checksum/upload gates must be unconditional");
    invariant(steps[index]["continue-on-error"] !== true, "CI binary release gates must be blocking");
  }
  return { valid: true, binary_artifact_verified: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const releasePath = resolve(process.argv[2] || ".github/workflows/release-binaries.yml");
  const ciPath = resolve(process.argv[3] || ".github/workflows/ci.yml");
  const release = validateReleaseWorkflow(parse(readFileSync(releasePath, "utf8")));
  const ci = validateCiWorkflow(parse(readFileSync(ciPath, "utf8")));
  process.stdout.write(`${JSON.stringify({ release, ci }, null, 2)}\n`);
}
