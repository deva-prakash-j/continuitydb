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

export function validateReleaseWorkflow(document) {
  const build = document?.jobs?.build;
  const publish = document?.jobs?.publish;
  invariant(build && publish, "build and publish jobs are required");
  invariant(build.strategy?.["fail-fast"] === false, "all native targets must complete even if one fails");
  const targets = build.strategy?.matrix?.include || [];
  const names = new Set(targets.map((target) => target.name));
  for (const required of ["linux-x64", "macos-x64", "macos-arm64", "windows-x64"]) {
    invariant(names.has(required), `native target ${required} is missing`);
  }

  const steps = build.steps || [];
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
  const downloadIndex = actionIndex(publishSteps, "actions/download-artifact@");
  const attestIndex = actionIndex(publishSteps, "actions/attest-build-provenance@");
  const releaseIndex = publishSteps.findIndex((step) => String(step.run || "").includes("gh release create"));
  invariant(downloadIndex >= 0 && attestIndex > downloadIndex && releaseIndex > attestIndex,
    "downloaded native artifacts must be attested before release publication");
  return { valid: true, native_targets: [...names].sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] || ".github/workflows/release-binaries.yml");
  const result = validateReleaseWorkflow(parse(readFileSync(path, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
