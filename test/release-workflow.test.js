import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { validateCiWorkflow, validateReleaseWorkflow } from "../scripts/validate-release-workflow.js";

const workflow = parse(readFileSync(new URL("../.github/workflows/release-binaries.yml", import.meta.url), "utf8"));
const ciWorkflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const packageDocument = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const openCodeSmoke = readFileSync(new URL("../scripts/opencode-global-smoke.js", import.meta.url), "utf8");

test("release workflow blocks publication on post-sign native semantic verification", () => {
  assert.equal(validateReleaseWorkflow(workflow).valid, true);
});

test("release workflow runs native gates on pull requests using supported targets", () => {
  assert.notEqual(workflow.on.pull_request, undefined);
  const targets = new Map(workflow.jobs.build.strategy.matrix.include.map((target) => [target.name, target.os]));
  assert.equal(targets.has("macos-x64"), false);
  assert.equal(targets.get("macos-arm64"), "macos-15");

  const noPullRequest = structuredClone(workflow);
  delete noPullRequest.on.pull_request;
  assert.throws(() => validateReleaseWorkflow(noPullRequest), /pull_request trigger is required/);

  const unsupportedIntel = structuredClone(workflow);
  unsupportedIntel.jobs.build.strategy.matrix.include.push({ name: "macos-x64", os: "macos-15-intel" });
  assert.throws(() => validateReleaseWorkflow(unsupportedIntel), /must not be published/);

  const retiredRunner = structuredClone(workflow);
  retiredRunner.jobs.build.strategy.matrix.include
    .find((target) => target.name === "macos-arm64").os = "macos-13";
  assert.throws(() => validateReleaseWorkflow(retiredRunner), /supported macos-15 runner/);
});

test("every main push publishes one idempotent commit-bound prerelease", () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.match(workflow.jobs.publish.if, /refs\/heads\/main/);

  const missingMain = structuredClone(workflow);
  missingMain.on.push.branches = [];
  assert.throws(() => validateReleaseWorkflow(missingMain), /every push to main/);

  const tagsOnly = structuredClone(workflow);
  tagsOnly.jobs.publish.if = "startsWith(github.ref, 'refs/tags/v')";
  assert.throws(() => validateReleaseWorkflow(tagsOnly), /main pushes and version-tag pushes/);

  const nonIdempotent = structuredClone(workflow);
  const publishStep = nonIdempotent.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  publishStep.run = publishStep.run.replace("gh release upload", "gh release replace");
  assert.throws(() => validateReleaseWorkflow(nonIdempotent), /idempotent/);

  const truncatedIdentity = structuredClone(workflow);
  const identityStep = truncatedIdentity.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Resolve idempotent release identity"));
  identityStep.run = identityStep.run.replace("main-${GITHUB_SHA}", "main-${GITHUB_SHA:0:12}");
  assert.throws(() => validateReleaseWorkflow(truncatedIdentity), /complete commit SHA/);

  const wrongExistingTarget = structuredClone(workflow);
  const wrongExistingTargetStep = wrongExistingTarget.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"));
  wrongExistingTargetStep.run = wrongExistingTargetStep.run
    .replace('[[ "$existing_target" == "$GITHUB_SHA" ]]', "true");
  assert.throws(() => validateReleaseWorkflow(wrongExistingTarget), /exact commit before refresh/);
});

test("publish path is repository-explicit outside a Git worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-release-publish-"));
  const bin = join(root, "bin");
  const output = join(root, "github-output");
  const calls = join(root, "gh-calls");
  const mkdir = spawnSync(process.execPath, ["-e", `require('node:fs').mkdirSync(${JSON.stringify(bin)}, { recursive: true })`]);
  assert.equal(mkdir.status, 0);
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$GH_CALL_LOG"\nif [[ "$1 $2" == "release view" ]]; then exit 1; fi\n`, "utf8");
  chmodSync(fakeGh, 0o755);
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "release", "continuitydb-linux-x64"), "fixture", "utf8");

  const sha = "0123456789abcdef0123456789abcdef01234567";
  const identity = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Resolve idempotent release identity"));
  const identityRun = spawnSync("bash", ["-c", identity.run], {
    cwd: root,
    env: { ...process.env, GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(identityRun.status, 0, identityRun.stderr);
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(outputs.tag, `main-${sha}`);

  const publish = workflow.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  const publishRun = spawnSync("bash", ["-c", `gh() { "$FAKE_GH" "$@"; }\n${publish.run}`], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_CALL_LOG: calls,
      FAKE_GH: fakeGh,
      GH_REPO: "deva-prakash-j/continuitydb",
      GITHUB_SHA: sha,
      RELEASE_TAG: outputs.tag,
      RELEASE_TITLE: outputs.title,
      RELEASE_PRERELEASE: outputs.prerelease,
    },
    encoding: "utf8",
  });
  assert.equal(publishRun.status, 0, publishRun.stderr);
  const command = readFileSync(calls, "utf8");
  assert.match(command, new RegExp(`release create main-${sha}`));
  assert.match(command, /--repo deva-prakash-j\/continuitydb/);
  assert.match(command, new RegExp(`--target ${sha}`));
});

test("published release verification validates bytes, exact assets, identity, and provenance", () => {
  const noRepository = structuredClone(workflow);
  const publish = noRepository.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  delete publish.env.GH_REPO;
  assert.throws(() => validateReleaseWorkflow(noRepository), /explicit GH_REPO/);

  const namesOnly = structuredClone(workflow);
  const verification = namesOnly.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));
  verification.run = "gh release view \"$RELEASE_TAG\" --repo \"$GH_REPO\" --json assets";
  assert.throws(() => validateReleaseWorkflow(namesOnly), /download from the explicit repository/);

  const noProvenance = structuredClone(workflow);
  const noProvenanceStep = noProvenance.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));
  noProvenanceStep.run = noProvenanceStep.run.replace("gh attestation verify", "gh attestation inspect");
  assert.throws(() => validateReleaseWorkflow(noProvenance), /provenance verification/);

  const binariesOnly = structuredClone(workflow);
  const binariesOnlyStep = binariesOnly.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));
  binariesOnlyStep.run = binariesOnlyStep.run.replace(
    'cmp -- "release/$asset" "$verify_dir/$asset"',
    'true # binary-only verifier omitted checksum-sidecar byte comparison',
  );
  assert.throws(() => validateReleaseWorkflow(binariesOnly), /all six published assets/);
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

  const expressionContinue = structuredClone(workflow);
  expressionContinue.jobs.build.steps
    .find((step) => step.run === "npm run smoke:binary:semantic")["continue-on-error"] = "${{ true }}";
  assert.throws(() => validateReleaseWorkflow(expressionContinue), /continue-on-error/);

  const expressionProvenance = structuredClone(workflow);
  expressionProvenance.jobs.publish.steps
    .find((step) => String(step.uses || "").startsWith("actions/attest-build-provenance@"))["continue-on-error"] = "${{ true }}";
  assert.throws(() => validateReleaseWorkflow(expressionProvenance), /continue-on-error/);
});

test("native and CI workflows cannot skip or ignore the real OpenCode global smoke", () => {
  const missingNative = structuredClone(workflow);
  missingNative.jobs.build.steps = missingNative.jobs.build.steps
    .filter((step) => step.run !== "npm run test:opencode-global");
  assert.throws(() => validateReleaseWorkflow(missingNative), /real OpenCode global integration smoke is missing/i);

  const conditionalNative = structuredClone(workflow);
  conditionalNative.jobs.build.steps
    .find((step) => step.run === "npm run test:opencode-global").if = "runner.os == 'Linux'";
  assert.throws(() => validateReleaseWorkflow(conditionalNative), /must run for every native matrix target/i);

  const ignoredNativeJob = structuredClone(workflow);
  ignoredNativeJob.jobs.build["continue-on-error"] = true;
  assert.throws(() => validateReleaseWorkflow(ignoredNativeJob), /OpenCode integration gates.*continue-on-error/i);

  const missingCi = structuredClone(ciWorkflow);
  missingCi.jobs.binary.steps = missingCi.jobs.binary.steps
    .filter((step) => step.run !== "npm run test:opencode-global");
  assert.throws(() => validateCiWorkflow(missingCi), /real OpenCode global integration smoke is missing/i);

  const skippedCiJob = structuredClone(ciWorkflow);
  skippedCiJob.jobs.binary.if = "github.ref == 'refs/heads/main'";
  assert.throws(() => validateCiWorkflow(skippedCiJob), /job must be unconditional/i);
});

test("real OpenCode smoke invokes remember and search through the installed plugin handlers", () => {
  assert.match(openCodeSmoke, /ContinuityDBGlobalPlugin/);
  assert.match(openCodeSmoke, /hooks\.tool\.continuitydb_remember\.execute/);
  assert.match(openCodeSmoke, /hooks\.tool\.continuitydb_memory_search\.execute/);
  assert.doesNotMatch(openCodeSmoke, /succeed\(binary, \[\s*"capture"/);
  assert.doesNotMatch(openCodeSmoke, /succeed\(binary, \[\s*"search"/);
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

test("normal, container, Linux binary, and supported native jobs run complete client validation", () => {
  const validatedCi = validateCiWorkflow(ciWorkflow);
  assert.equal(validatedCi.client_adapters_verified, true);
  assert.deepEqual(ciWorkflow.jobs.test.strategy.matrix.node, [22, 24]);
  for (const jobName of ["test", "container", "binary"]) {
    const commands = (ciWorkflow.jobs[jobName].steps || []).map((step) => step.run);
    assert.ok(commands.includes("npm run validate:clients"), `${jobName} omits adapter validation`);
  }
  assert.ok(ciWorkflow.jobs.container.steps.some((step) => step.run === "npm run test:clients"));

  const validatedRelease = validateReleaseWorkflow(workflow);
  assert.equal(validatedRelease.client_adapters_verified, true);
  const nativeCommands = workflow.jobs.build.steps.map((step) => step.run);
  assert.ok(nativeCommands.includes("npm run validate:clients"));
  assert.ok(nativeCommands.includes("npm run test:clients"));

  const missingCiValidation = structuredClone(ciWorkflow);
  missingCiValidation.jobs.container.steps = missingCiValidation.jobs.container.steps
    .filter((step) => step.run !== "npm run validate:clients");
  assert.throws(() => validateCiWorkflow(missingCiValidation), /container.*client adapter validation/i);

  const missingNativeValidation = structuredClone(workflow);
  missingNativeValidation.jobs.build.steps = missingNativeValidation.jobs.build.steps
    .filter((step) => step.run !== "npm run test:clients");
  assert.throws(() => validateReleaseWorkflow(missingNativeValidation), /native.*client adapter tests/i);
});

test("stable publication waits for every native and provenance gate", () => {
  assert.ok(workflow.on.push.tags.includes("v*"));
  assert.match(workflow.jobs.publish.if, /github\.event_name == 'push'/);
  assert.doesNotMatch(workflow.jobs.publish.if, /always\(\)/);
  const provenance = workflow.jobs.publish.steps
    .find((step) => String(step.uses || "").startsWith("actions/attest-build-provenance@"));
  assert.equal(provenance.with["subject-path"], "release/continuitydb-*");

  const falseSuccess = structuredClone(workflow);
  falseSuccess.jobs.publish.if = `always() && (${falseSuccess.jobs.publish.if})`;
  assert.throws(() => validateReleaseWorkflow(falseSuccess), /terminal success.*native/i);

  const noStableTag = structuredClone(workflow);
  noStableTag.on.push.tags = ["main-*"];
  assert.throws(() => validateReleaseWorkflow(noStableTag), /stable version tag path/i);
});

test("stable publication requires exact package version, merged ancestry, and remote tag identity", () => {
  assert.equal(validateReleaseWorkflow(workflow).valid, true);

  const stableGate = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify stable tag release eligibility"));
  assert.ok(stableGate, "stable eligibility gate is missing");

  const mutations = [
    ["version", /stable tag must exactly match package version/i,
      (run) => run.replace('[[ "$GITHUB_REF_NAME" == "v${package_version}" ]]', "true")],
    ["ancestry", /stable tag commit must be merged into origin\/main/i,
      (run) => run.replace('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main', "true")],
    ["remote tag target", /remote stable tag must resolve to the exact workflow commit/i,
      (run) => run.replace('[[ "$stable_tag_sha" == "$GITHUB_SHA" ]]', "true")],
    ["local tag target", /local stable tag must resolve to the exact workflow commit/i,
      (run) => run.replace('[[ "$local_tag_sha" == "$GITHUB_SHA" ]]', "true")],
  ];
  for (const [name, expected, mutate] of mutations) {
    const invalid = structuredClone(workflow);
    const step = invalid.jobs.publish.steps
      .find((candidate) => String(candidate.name || "").includes("Verify stable tag release eligibility"));
    step.run = mutate(step.run);
    assert.throws(() => validateReleaseWorkflow(invalid), expected, name);
  }

  const shallowCheckout = structuredClone(workflow);
  const checkout = shallowCheckout.jobs.publish.steps
    .find((step) => String(step.uses || "").startsWith("actions/checkout@"));
  checkout.with["fetch-depth"] = 1;
  assert.throws(() => validateReleaseWorkflow(shallowCheckout), /complete history/i);

  const credentialedCheckout = structuredClone(workflow);
  credentialedCheckout.jobs.publish.steps
    .find((step) => String(step.uses || "").startsWith("actions/checkout@"))
    .with["persist-credentials"] = true;
  assert.throws(() => validateReleaseWorkflow(credentialedCheckout), /credentials must remain disabled/i);

  const skippedGate = structuredClone(workflow);
  skippedGate.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify stable tag release eligibility"))
    .if = "${{ false }}";
  assert.throws(() => validateReleaseWorkflow(skippedGate), /stable release eligibility.*unconditional/i);

  const ignoredGate = structuredClone(workflow);
  ignoredGate.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify stable tag release eligibility"))
    ["continue-on-error"] = "${{ true }}";
  assert.throws(() => validateReleaseWorkflow(ignoredGate), /continue-on-error/i);

  const wrongRefCondition = structuredClone(workflow);
  const wrongRefStep = wrongRefCondition.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify stable tag release eligibility"));
  wrongRefStep.run = wrongRefStep.run.replace(
    'if [[ "$GITHUB_REF" != refs/tags/v* ]]; then',
    'if [[ "$GITHUB_REF" != refs/heads/main ]]; then',
  );
  assert.throws(() => validateReleaseWorkflow(wrongRefCondition), /stable tag event condition/i);
});

test("stable release mutation and post-publication verification recheck exact remote tag target", () => {
  const publish = workflow.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  const verify = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));

  const noPremutationTarget = structuredClone(workflow);
  noPremutationTarget.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"))
    .run = publish.run.replace('[[ "$stable_tag_sha" == "$GITHUB_SHA" ]]', "true");
  assert.throws(() => validateReleaseWorkflow(noPremutationTarget), /stable tag target.*before release mutation/i);

  const ambiguousPremutationTarget = structuredClone(workflow);
  ambiguousPremutationTarget.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"))
    .run = publish.run.replace("resolve_remote_tag_commit", "gh release view");
  assert.throws(() => validateReleaseWorkflow(ambiguousPremutationTarget), /stable tag target.*before release mutation/i);

  const noPublishedTarget = structuredClone(workflow);
  noPublishedTarget.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"))
    .run = verify.run.replace('[[ "$stable_tag_sha" == "$GITHUB_SHA" ]]', "true");
  assert.throws(() => validateReleaseWorkflow(noPublishedTarget), /stable tag target.*after publication/i);

  const ignoredPublication = structuredClone(workflow);
  ignoredPublication.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"))
    ["continue-on-error"] = "${{ true }}";
  assert.throws(() => validateReleaseWorkflow(ignoredPublication), /continue-on-error/i);

  const wrongMutationCondition = structuredClone(workflow);
  const wrongMutationStep = wrongMutationCondition.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"));
  wrongMutationStep.run = wrongMutationStep.run.replace(
    'if [[ "$RELEASE_PRERELEASE" == "false" ]]; then',
    'if [[ "$RELEASE_PRERELEASE" == "true" ]]; then',
  );
  assert.throws(() => validateReleaseWorkflow(wrongMutationCondition), /stable tag target condition.*before release mutation/i);

  const wrongPostCondition = structuredClone(workflow);
  const wrongPostStep = wrongPostCondition.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));
  wrongPostStep.run = wrongPostStep.run.replace(
    'if [[ "$RELEASE_PRERELEASE" == "true" ]]; then',
    'if [[ "$RELEASE_PRERELEASE" == "false" ]]; then',
  );
  assert.throws(() => validateReleaseWorkflow(wrongPostCondition), /stable tag target condition.*after publication/i);
});

test("stable mutation branches freshly recheck main ancestry and tag immediately before mutation", () => {
  const publish = workflow.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  const verify = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));

  assert.match(publish.run, /verify_stable_release_state\(\)/);
  assert.match(
    publish.run,
    /if \[\[ "\$RELEASE_PRERELEASE" == "false" \]\]; then\s+verify_stable_release_state\s+fi\s+gh release upload/,
  );
  assert.match(
    publish.run,
    /else\s+verify_stable_release_state\s+gh release create "\$RELEASE_TAG" release\/\*/,
  );
  assert.match(verify.run, /verify_stable_release_state\(\)/);
  assert.match(
    verify.run,
    /else\s+published_tag=[\s\S]*?\[\[ "\$published_prerelease" == "false" \]\]\s+verify_stable_release_state\s+fi/,
  );

  const staleUploadAncestry = structuredClone(workflow);
  staleUploadAncestry.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"))
    .run = publish.run.replace(
      /if \[\[ "\$RELEASE_PRERELEASE" == "false" \]\]; then\s+verify_stable_release_state\s+fi\s+gh release upload/,
      'if [[ "$RELEASE_PRERELEASE" == "false" ]]; then\n              resolve_remote_tag_commit >/dev/null\n            fi\n            gh release upload',
    );
  assert.throws(() => validateReleaseWorkflow(staleUploadAncestry), /fresh ancestry and tag checks.*stable upload/i);

  const staleCreateAncestry = structuredClone(workflow);
  staleCreateAncestry.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"))
    .run = publish.run.replace(
      /else\s+verify_stable_release_state\s+gh release create "\$RELEASE_TAG" release\/\*/,
      'else\n            resolve_remote_tag_commit >/dev/null\n            gh release create "$RELEASE_TAG" release/*',
    );
  assert.throws(() => validateReleaseWorkflow(staleCreateAncestry), /fresh ancestry and tag checks.*stable create/i);

  const stalePostAncestry = structuredClone(workflow);
  stalePostAncestry.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"))
    .run = verify.run.replace(
      /\[\[ "\$published_prerelease" == "false" \]\]\s+verify_stable_release_state/,
      '[[ "$published_prerelease" == "false" ]]',
    );
  assert.throws(() => validateReleaseWorkflow(stalePostAncestry), /fresh ancestry and tag checks.*after stable release metadata/i);

  for (const [name, mutate] of [
    ["package identity", (run) => run.replace('[[ "$GITHUB_REF_NAME" == "v${package_version}" ]]', "true")],
    ["local tag identity", (run) => run.replace('[[ "$local_tag_sha" == "$GITHUB_SHA" ]]', "true")],
  ]) {
    const incomplete = structuredClone(workflow);
    const step = incomplete.jobs.publish.steps.find((candidate) => String(candidate.run || "").includes("gh release create"));
    step.run = mutate(step.run);
    assert.throws(
      () => validateReleaseWorkflow(incomplete),
      /stable tag target and fresh ancestry checks.*before release mutation/i,
      name,
    );
  }
});

test("existing and published releases must be non-draft", () => {
  const publish = workflow.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  const verify = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));

  assert.match(publish.run, /--json isDraft --jq '\.isDraft'/);
  assert.match(publish.run, /\[\[ "\$existing_draft" == "false" \]\]/);
  assert.match(verify.run, /--json isDraft --jq '\.isDraft'/);
  assert.match(verify.run, /\[\[ "\$published_draft" == "false" \]\]/);

  const noExistingDraftGate = structuredClone(workflow);
  noExistingDraftGate.jobs.publish.steps
    .find((step) => String(step.run || "").includes("gh release create"))
    .run = publish.run.replace('[[ "$existing_draft" == "false" ]]', "true");
  assert.throws(() => validateReleaseWorkflow(noExistingDraftGate), /existing release must not be a draft/i);

  const noPublishedDraftGate = structuredClone(workflow);
  noPublishedDraftGate.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"))
    .run = verify.run.replace('[[ "$published_draft" == "false" ]]', "true");
  assert.throws(() => validateReleaseWorkflow(noPublishedDraftGate), /published release must not be a draft/i);
});

function runStableShell({
  refName = "v0.7.0",
  sha,
  mainAncestor = true,
  remoteTagSha = sha,
  mutationRemoteTagSha = remoteTagSha,
  existing = false,
  draft = false,
  prerelease = false,
  target = sha,
  moveTagDuringReleaseLookup = "",
  moveMainDuringReleaseLookup = "",
}) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-stable-release-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  mkdirSync(join(root, "release"));
  writeFileSync(calls, "", "utf8");
  const tagState = join(root, "remote-tag-state");
  const mainState = join(root, "main-state");
  writeFileSync(tagState, remoteTagSha, "utf8");
  writeFileSync(mainState, String(mainAncestor), "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.7.0" }), "utf8");
  writeFileSync(join(root, "release", "continuitydb-linux-x64"), "fixture", "utf8");

  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'git %s\\n' "$*" >> "$CALL_LOG"\ncase "$1" in\n  fetch) exit 0 ;;\n  merge-base) [[ "$(cat "$MAIN_STATE")" == true ]] ;;\n  rev-parse) printf '%s\\n' "$REMOTE_TAG_SHA" ;;\n  *) exit 2 ;;\nesac\n`, "utf8");
  chmodSync(fakeGit, 0o755);

  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'gh %s\\n' "$*" >> "$CALL_LOG"\nif [[ "$1 $2" == "api repos/test/repo/git/ref/tags/$GITHUB_REF_NAME" ]]; then\n  if [[ "$*" == *".object.type"* ]]; then printf 'commit\\n'; else cat "$TAG_STATE"; printf '\\n'; fi\n  exit 0\nfi\nif [[ "$1 $2" == "release view" ]]; then\n  if [[ -n "$MOVE_TAG_DURING_RELEASE_LOOKUP" ]]; then printf '%s' "$MOVE_TAG_DURING_RELEASE_LOOKUP" > "$TAG_STATE"; fi\n  if [[ -n "$MOVE_MAIN_DURING_RELEASE_LOOKUP" ]]; then printf '%s' "$MOVE_MAIN_DURING_RELEASE_LOOKUP" > "$MAIN_STATE"; fi\n  [[ "$RELEASE_EXISTS" == true ]] || exit 1\n  if [[ "$*" == *"isPrerelease"* ]]; then printf '%s\\n' "$RELEASE_PRERELEASE_STATE"; fi\n  if [[ "$*" == *"isDraft"* ]]; then printf '%s\\n' "$RELEASE_DRAFT"; fi\n  if [[ "$*" == *"targetCommitish"* ]]; then printf '%s\\n' "$RELEASE_TARGET"; fi\n  exit 0\nfi\nexit 0\n`, "utf8");
  chmodSync(fakeGh, 0o755);

  const stableGate = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify stable tag release eligibility"));
  const publish = workflow.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  const commonEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: calls,
    MAIN_ANCESTOR: String(mainAncestor),
    MAIN_STATE: mainState,
    REMOTE_TAG_SHA: remoteTagSha,
    TAG_STATE: tagState,
    RELEASE_EXISTS: String(existing),
    RELEASE_DRAFT: String(draft),
    RELEASE_PRERELEASE_STATE: String(prerelease),
    RELEASE_TARGET: target,
    MOVE_TAG_DURING_RELEASE_LOOKUP: moveTagDuringReleaseLookup,
    MOVE_MAIN_DURING_RELEASE_LOOKUP: moveMainDuringReleaseLookup,
    GITHUB_REF: `refs/tags/${refName}`,
    GITHUB_REF_NAME: refName,
    GITHUB_SHA: sha,
    GH_REPO: "test/repo",
    FAKE_GIT: fakeGit,
    FAKE_GH: fakeGh,
    RELEASE_TAG: refName,
    RELEASE_TITLE: `ContinuityDB ${refName}`,
    RELEASE_PRERELEASE: "false",
  };
  const fakeCommands = 'git() { "$FAKE_GIT" "$@"; }\ngh() { "$FAKE_GH" "$@"; }\n';
  const eligibility = spawnSync("bash", ["-c", `${fakeCommands}${stableGate.run}`], {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
  });
  let mutation = null;
  if (eligibility.status === 0) {
    writeFileSync(tagState, mutationRemoteTagSha, "utf8");
    writeFileSync(mainState, String(mainAncestor), "utf8");
    mutation = spawnSync("bash", ["-c", `${fakeCommands}${publish.run}`], {
      cwd: root,
      env: { ...commonEnv, REMOTE_TAG_SHA: mutationRemoteTagSha },
      encoding: "utf8",
    });
  }
  return {
    eligibility,
    mutation,
    calls: readFileSync(calls, "utf8"),
  };
}

test("stable execution gate fails before release mutation and accepts only the exact valid path", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  const versionMismatch = runStableShell({ refName: "v0.7.1", sha });
  assert.notEqual(versionMismatch.eligibility.status, 0);
  assert.doesNotMatch(versionMismatch.calls, /gh release (create|upload)/);

  const unmerged = runStableShell({ sha, mainAncestor: false });
  assert.notEqual(unmerged.eligibility.status, 0);
  assert.doesNotMatch(unmerged.calls, /gh release (create|upload)/);

  const wrongTag = runStableShell({ sha, remoteTagSha: "f".repeat(40) });
  assert.notEqual(wrongTag.eligibility.status, 0);
  assert.doesNotMatch(wrongTag.calls, /gh release (create|upload)/);

  const movedBeforeMutation = runStableShell({ sha, mutationRemoteTagSha: "e".repeat(40) });
  assert.equal(movedBeforeMutation.eligibility.status, 0, movedBeforeMutation.eligibility.stderr);
  assert.notEqual(movedBeforeMutation.mutation.status, 0);
  assert.doesNotMatch(movedBeforeMutation.calls, /gh release (create|upload)/);

  const valid = runStableShell({ sha });
  assert.equal(valid.eligibility.status, 0, `${valid.eligibility.stderr}\n${valid.calls}`);
  assert.equal(valid.mutation.status, 0, valid.mutation.stderr);
  assert.match(valid.calls, /gh release create v0\.7\.0/);

  const existing = runStableShell({ sha, existing: true });
  assert.equal(existing.eligibility.status, 0, existing.eligibility.stderr);
  assert.equal(existing.mutation.status, 0, existing.mutation.stderr);
  assert.match(existing.calls, /gh release upload v0\.7\.0/);
});

test("stable execution rechecks lookup-time tag and main movement and rejects draft uploads", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  const tagMovedDuringLookup = runStableShell({
    sha,
    existing: true,
    moveTagDuringReleaseLookup: "e".repeat(40),
  });
  assert.equal(tagMovedDuringLookup.eligibility.status, 0, tagMovedDuringLookup.eligibility.stderr);
  assert.notEqual(tagMovedDuringLookup.mutation.status, 0);
  assert.doesNotMatch(tagMovedDuringLookup.calls, /gh release upload v0\.7\.0/);

  const tagMovedDuringMissingLookup = runStableShell({
    sha,
    moveTagDuringReleaseLookup: "d".repeat(40),
  });
  assert.equal(tagMovedDuringMissingLookup.eligibility.status, 0, tagMovedDuringMissingLookup.eligibility.stderr);
  assert.notEqual(tagMovedDuringMissingLookup.mutation.status, 0);
  assert.doesNotMatch(tagMovedDuringMissingLookup.calls, /gh release create v0\.7\.0/);

  const mainMovedDuringLookup = runStableShell({
    sha,
    existing: true,
    moveMainDuringReleaseLookup: "false",
  });
  assert.equal(mainMovedDuringLookup.eligibility.status, 0, mainMovedDuringLookup.eligibility.stderr);
  assert.notEqual(mainMovedDuringLookup.mutation.status, 0);
  assert.doesNotMatch(mainMovedDuringLookup.calls, /gh release upload v0\.7\.0/);

  const stableDraft = runStableShell({ sha, existing: true, draft: true });
  assert.equal(stableDraft.eligibility.status, 0, stableDraft.eligibility.stderr);
  assert.notEqual(stableDraft.mutation.status, 0);
  assert.doesNotMatch(stableDraft.calls, /gh release upload v0\.7\.0/);
});

test("existing main prerelease rejects draft state before refresh", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const root = mkdtempSync(join(tmpdir(), "continuitydb-main-draft-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  mkdirSync(join(root, "release"));
  writeFileSync(calls, "", "utf8");
  writeFileSync(join(root, "release", "continuitydb-linux-x64"), "fixture", "utf8");
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'gh %s\\n' "$*" >> "$CALL_LOG"\nif [[ "$1 $2" == "release view" ]]; then\n  if [[ "$*" == *"isPrerelease"* ]]; then printf 'true\\n'; fi\n  if [[ "$*" == *"isDraft"* ]]; then printf 'true\\n'; fi\n  if [[ "$*" == *"targetCommitish"* ]]; then printf '%s\\n' "$GITHUB_SHA"; fi\n  exit 0\nfi\nexit 0\n`, "utf8");
  chmodSync(fakeGh, 0o755);
  const publish = workflow.jobs.publish.steps.find((step) => String(step.run || "").includes("gh release create"));
  const result = spawnSync("bash", ["-c", `gh() { "$FAKE_GH" "$@"; }\n${publish.run}`], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      FAKE_GH: fakeGh,
      GH_REPO: "test/repo",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sha,
      RELEASE_TAG: `main-${sha}`,
      RELEASE_TITLE: `ContinuityDB main build ${sha.slice(0, 12)}`,
      RELEASE_PRERELEASE: "true",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /gh release upload/);
});

function runPublishedStableShell({
  sha,
  draft = false,
  mainAncestor = true,
  remoteTagSha = sha,
  moveTagDuringMetadata = "",
  moveMainDuringMetadata = "",
}) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-published-stable-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  const release = join(root, "release");
  const mainState = join(root, "main-state");
  const tagState = join(root, "tag-state");
  mkdirSync(bin);
  mkdirSync(release);
  writeFileSync(calls, "", "utf8");
  writeFileSync(mainState, String(mainAncestor), "utf8");
  writeFileSync(tagState, remoteTagSha, "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.7.0" }), "utf8");
  for (const name of ["continuitydb-linux-x64", "continuitydb-darwin-arm64", "continuitydb-win32-x64.exe"]) {
    const body = `fixture:${name}`;
    writeFileSync(join(release, name), body, "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(release, `${name}.sha256`), `${digest}  ${name}\n`, "utf8");
  }

  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'git %s\\n' "$*" >> "$CALL_LOG"\ncase "$1" in\n  fetch) exit 0 ;;\n  merge-base) [[ "$(cat "$MAIN_STATE")" == true ]] ;;\n  rev-parse) printf '%s\\n' "$GITHUB_SHA" ;;\n  *) exit 2 ;;\nesac\n`, "utf8");
  chmodSync(fakeGit, 0o755);
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'gh %s\\n' "$*" >> "$CALL_LOG"\nif [[ "$1 $2" == "api repos/test/repo/git/ref/tags/$GITHUB_REF_NAME" ]]; then\n  if [[ "$*" == *".object.type"* ]]; then printf 'commit\\n'; else cat "$TAG_STATE"; printf '\\n'; fi\n  exit 0\nfi\nif [[ "$1 $2" == "release view" ]]; then\n  if [[ "$*" == *"isPrerelease"* ]]; then printf 'false\\n'; fi\n  if [[ "$*" == *"isDraft"* ]]; then printf '%s\\n' "$RELEASE_DRAFT"; fi\n  if [[ "$*" == *"tagName"* ]]; then\n    printf '%s\\n' "$GITHUB_REF_NAME"\n    if [[ -n "$MOVE_TAG_DURING_METADATA" ]]; then printf '%s' "$MOVE_TAG_DURING_METADATA" > "$TAG_STATE"; fi\n    if [[ -n "$MOVE_MAIN_DURING_METADATA" ]]; then printf '%s' "$MOVE_MAIN_DURING_METADATA" > "$MAIN_STATE"; fi\n  fi\n  exit 0\nfi\nif [[ "$1 $2" == "release download" ]]; then\n  destination=''\n  while (( $# > 0 )); do\n    if [[ "$1" == "--dir" ]]; then destination="$2"; break; fi\n    shift\n  done\n  cp "$SOURCE_RELEASE_DIR"/* "$destination"/\n  exit 0\nfi\nif [[ "$1 $2" == "attestation verify" ]]; then exit 0; fi\nexit 2\n`, "utf8");
  chmodSync(fakeGh, 0o755);
  const verify = workflow.jobs.publish.steps
    .find((step) => String(step.name || "").includes("Verify published release assets"));
  const result = spawnSync("bash", ["-c", `git() { "$FAKE_GIT" "$@"; }\ngh() { "$FAKE_GH" "$@"; }\n${verify.run}`], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      FAKE_GIT: fakeGit,
      FAKE_GH: fakeGh,
      MAIN_STATE: mainState,
      TAG_STATE: tagState,
      SOURCE_RELEASE_DIR: release,
      RELEASE_DRAFT: String(draft),
      MOVE_TAG_DURING_METADATA: moveTagDuringMetadata,
      MOVE_MAIN_DURING_METADATA: moveMainDuringMetadata,
      GH_REPO: "test/repo",
      GITHUB_REF: "refs/tags/v0.7.0",
      GITHUB_REF_NAME: "v0.7.0",
      GITHUB_SHA: sha,
      RELEASE_TAG: "v0.7.0",
      RELEASE_PRERELEASE: "false",
    },
    encoding: "utf8",
  });
  return { result, calls: readFileSync(calls, "utf8") };
}

test("post-publication execution requires non-draft state and fresh stable identity", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  const valid = runPublishedStableShell({ sha });
  assert.equal(valid.result.status, 0, `${valid.result.stderr}\n${valid.calls}`);
  assert.match(valid.calls, /gh release download v0\.7\.0/);

  const draft = runPublishedStableShell({ sha, draft: true });
  assert.notEqual(draft.result.status, 0);
  assert.doesNotMatch(draft.calls, /gh release download/);

  const unmerged = runPublishedStableShell({ sha, mainAncestor: false });
  assert.notEqual(unmerged.result.status, 0);
  assert.doesNotMatch(unmerged.calls, /gh release download/);

  const movedTag = runPublishedStableShell({ sha, remoteTagSha: "f".repeat(40) });
  assert.notEqual(movedTag.result.status, 0);
  assert.doesNotMatch(movedTag.calls, /gh release download/);

  const tagMovedDuringMetadata = runPublishedStableShell({
    sha,
    moveTagDuringMetadata: "e".repeat(40),
  });
  assert.notEqual(tagMovedDuringMetadata.result.status, 0);
  assert.doesNotMatch(tagMovedDuringMetadata.calls, /gh release download/);

  const mainMovedDuringMetadata = runPublishedStableShell({
    sha,
    moveMainDuringMetadata: "false",
  });
  assert.notEqual(mainMovedDuringMetadata.result.status, 0);
  assert.doesNotMatch(mainMovedDuringMetadata.calls, /gh release download/);
});

test("release check builds once before generated Codex and real OpenCode integration probes", () => {
  assert.equal(packageDocument.scripts["test:codex-config"], "npm run test:codex-generated-config");
  assert.equal(
    packageDocument.scripts["test:codex-generated-config"],
    "npm run build:binary && node scripts/codex-generated-config-probe.js",
  );
  assert.match(packageDocument.scripts["release:check"], /npm run test:codex-config && npm run test:opencode-global$/);
});
