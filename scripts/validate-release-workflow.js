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

function requireBlockingStep(step, message) {
  invariant(step && !step.if, `${message}; the step must be unconditional`);
  invariant(step["continue-on-error"] === undefined || step["continue-on-error"] === false,
    `${message}; continue-on-error must be absent or the literal boolean false`);
}

function requireBlockingCommand(steps, command, message) {
  const index = runIndex(steps, command);
  invariant(index >= 0, message);
  requireBlockingStep(steps[index], message);
  return index;
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
  const push = document?.on?.push;
  invariant(Array.isArray(push?.branches) && push.branches.includes("main"),
    "every push to main must trigger the native release workflow");
  invariant(Array.isArray(push?.tags) && push.tags.includes("v*"),
    "stable v0.7.0 tag path requires the version-tag release trigger v*");
  const build = document?.jobs?.build;
  const publish = document?.jobs?.publish;
  invariant(build && publish, "build and publish jobs are required");
  invariant(build.strategy?.["fail-fast"] === false, "all native targets must complete even if one fails");
  const targets = build.strategy?.matrix?.include || [];
  const names = new Set(targets.map((target) => target.name));
  for (const required of ["linux-x64", "macos-arm64", "windows-x64"]) {
    invariant(names.has(required), `native target ${required} is missing`);
  }
  invariant(!names.has("macos-x64"),
    "macos-x64 must not be published while upstream Node SEA crashes on Intel macOS");
  const targetByName = new Map(targets.map((target) => [target.name, target]));
  invariant(targetByName.get("macos-arm64")?.os === "macos-15",
    "macos-arm64 must use the supported macos-15 runner");

  const steps = build.steps || [];
  validatePinnedActions(steps);
  requireBlockingCommand(steps, "npm run validate:clients", "native client adapter validation is missing");
  requireBlockingCommand(steps, "npm run test:clients", "native client adapter tests are missing");
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
    requireBlockingStep(steps[index],
      "verification/checksum/upload gates must run for every native matrix target");
  }

  const needs = Array.isArray(publish.needs) ? publish.needs : [publish.needs];
  invariant(needs.includes("build"), "publish must depend on every native build matrix result");
  const publishCondition = String(publish.if || "");
  invariant(publishCondition.includes("refs/heads/main") && publishCondition.includes("refs/tags/v"),
    "publish must run for main pushes and version-tag pushes only");
  invariant(publishCondition.includes("success()") && !publishCondition.includes("always()"),
    "publication requires terminal success of every supported native build");
  const publishSteps = publish.steps || [];
  validatePinnedActions(publishSteps);
  const downloadIndex = actionIndex(publishSteps, "actions/download-artifact@");
  const verifyIndex = publishSteps.findIndex((step) => String(step.name || "").includes("Verify complete native release set"));
  const attestIndex = actionIndex(publishSteps, "actions/attest-build-provenance@");
  const releaseIndex = publishSteps.findIndex((step) => String(step.run || "").includes("gh release create"));
  const publishedVerifyIndex = publishSteps.findIndex((step) => String(step.name || "").includes("Verify published release assets"));
  invariant(downloadIndex >= 0 && verifyIndex > downloadIndex && attestIndex > verifyIndex && releaseIndex > attestIndex,
    "downloaded native artifacts must be checksum-verified and attested before release publication");
  invariant(publishSteps[attestIndex]?.with?.["subject-path"] === "release/continuitydb-*",
    "provenance must cover the complete supported native asset set");
  requireBlockingStep(publishSteps[attestIndex],
    "provenance for the complete supported native asset set must succeed before publication");
  invariant(publishedVerifyIndex > releaseIndex,
    "published release assets must be independently verified after publication");
  const verifyCommand = String(publishSteps[verifyIndex]?.run || "");
  for (const asset of ["continuitydb-linux-x64", "continuitydb-darwin-arm64", "continuitydb-win32-x64.exe"]) {
    invariant(verifyCommand.includes(asset), `release verification must require ${asset}`);
  }
  invariant(verifyCommand.includes("sha256sum -c"), "release artifact checksums must be verified before publication");
  const identityStep = publishSteps.find((step) => String(step.name || "").includes("Resolve idempotent release identity"));
  const identityCommand = String(identityStep?.run || "");
  invariant(identityCommand.includes('tag=main-${GITHUB_SHA}') && !identityCommand.includes('tag=main-${GITHUB_SHA:0:'),
    "main prerelease tag must contain the complete commit SHA");
  const releaseCommand = String(publishSteps[releaseIndex]?.run || "");
  const releaseEnvironment = publishSteps[releaseIndex]?.env || {};
  invariant(String(releaseEnvironment.GH_REPO || "").includes("github.repository"),
    "publish commands require an explicit GH_REPO outside a Git checkout");
  invariant(releaseCommand.includes('--repo "$GH_REPO"'),
    "every release operation must explicitly target GH_REPO");
  invariant(releaseCommand.includes("gh release upload") && releaseCommand.includes("--clobber"),
    "release publication must be idempotent on workflow reruns");
  invariant(releaseCommand.includes("--target \"$GITHUB_SHA\"") && releaseCommand.includes("--prerelease"),
    "main pushes must create commit-bound prereleases");
  invariant(releaseCommand.includes("targetCommitish") && releaseCommand.includes('[[ "$existing_target" == "$GITHUB_SHA" ]]'),
    "an existing main prerelease must be bound to the exact commit before refresh");
  invariant(releaseCommand.includes("isPrerelease") && releaseCommand.includes('[[ "$existing_prerelease" == "true" ]]'),
    "an existing main release must remain a prerelease before refresh");

  const publishedVerifyCommand = String(publishSteps[publishedVerifyIndex]?.run || "");
  const publishedVerifyEnvironment = publishSteps[publishedVerifyIndex]?.env || {};
  invariant(String(publishedVerifyEnvironment.GH_REPO || "").includes("github.repository"),
    "post-publication verification requires explicit GH_REPO");
  invariant(publishedVerifyCommand.includes("gh release download") && publishedVerifyCommand.includes('--repo "$GH_REPO"'),
    "post-publication verification must download from the explicit repository");
  invariant(publishedVerifyCommand.includes('[[ "${actual[*]}" == "${expected[*]}" ]]'),
    "post-publication verification must enforce the exact six-asset set");
  invariant(publishedVerifyCommand.includes('for asset in "${expected[@]}"') &&
    publishedVerifyCommand.includes('cmp -- "release/$asset" "$verify_dir/$asset"'),
    "all six published assets must match the verified build inputs byte-for-byte");
  invariant(publishedVerifyCommand.includes("sha256sum -c"),
    "downloaded checksum sidecars must be verified");
  invariant(publishedVerifyCommand.includes("gh attestation verify") &&
    publishedVerifyCommand.includes('--repo "$GH_REPO"') &&
    publishedVerifyCommand.includes('gh attestation verify "$verify_dir/$asset"'),
    "all six published assets must pass provenance verification");
  invariant(publishedVerifyCommand.includes("targetCommitish") && publishedVerifyCommand.includes("isPrerelease"),
    "published release identity must be verified after publication");
  return { valid: true, native_targets: [...names].sort(), client_adapters_verified: true };
}

export function validateCiWorkflow(document) {
  const jobs = document?.jobs || {};
  invariant(jobs.test && jobs.container && jobs.binary, "CI test, container, and binary jobs are required");
  invariant(Array.isArray(jobs.test.strategy?.matrix?.node)
    && jobs.test.strategy.matrix.node.length === 2
    && jobs.test.strategy.matrix.node.includes(22)
    && jobs.test.strategy.matrix.node.includes(24),
  "CI source tests must run on Node 22 and Node 24");
  for (const job of Object.values(jobs)) validatePinnedActions(job.steps || []);
  for (const jobName of ["test", "container", "binary"]) {
    requireBlockingCommand(jobs[jobName].steps || [], "npm run validate:clients",
      `${jobName} client adapter validation is missing`);
  }
  requireBlockingCommand(jobs.container.steps || [], "npm run test:clients",
    "container client adapter tests are missing");
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
    requireBlockingStep(steps[index], "CI binary verification/checksum/upload gates must be blocking");
  }
  return { valid: true, binary_artifact_verified: true, client_adapters_verified: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const releasePath = resolve(process.argv[2] || ".github/workflows/release-binaries.yml");
  const ciPath = resolve(process.argv[3] || ".github/workflows/ci.yml");
  const release = validateReleaseWorkflow(parse(readFileSync(releasePath, "utf8")));
  const ci = validateCiWorkflow(parse(readFileSync(ciPath, "utf8")));
  process.stdout.write(`${JSON.stringify({ release, ci }, null, 2)}\n`);
}
