import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderGlobalOpenCodePlugin } from "../src/opencode-global-plugin-template.js";

function fakeCli(root) {
  const path = join(root, "fake-continuitydb");
  const log = join(root, "calls.jsonl");
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const command = args[0];
const value = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
if (command === "opencode" && args[1] === "ensure") {
  process.stdout.write(JSON.stringify({ project: { id: "service", root: value("--project-dir"), source: "git" }, changed: false, applied: true }));
} else if (command === "context") {
  process.stdout.write(JSON.stringify({ project_id: value("--project"), task: args[1], memories: [{ title: "Repository convention", body: "Use billing-api naming." }] }));
} else if (command === "search") {
  process.stdout.write(JSON.stringify({ results: [{ project_id: value("--project"), body: "Scoped search result" }] }));
} else if (command === "capture") {
  if ((value("--body") || "").includes("SECRET")) { process.stderr.write(JSON.stringify({ error: "secret-looking content rejected" })); process.exit(1); }
  process.stdout.write(JSON.stringify({ record: { id: "memory-1", project_id: value("--project"), status: "active" }, disposition: "active" }));
} else { process.stderr.write(JSON.stringify({ error: "unexpected command", args })); process.exit(2); }
`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { path, log };
}

async function importGenerated(source) {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-generated-plugin-"));
  const path = join(root, "plugin.mjs");
  const moduleSource = source.replace('from "@opencode-ai/plugin";', `from ${JSON.stringify(import.meta.resolve("@opencode-ai/plugin"))};`);
  writeFileSync(path, moduleSource, { flag: "wx", mode: 0o600 });
  try { return await import(`${pathToFileURL(path).href}?v=${Date.now()}`); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("global plugin automatically ensures the Git project and injects first-task context", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-global-"));
  const workspace = join(root, "workspace");
  const repo = join(workspace, "service");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const cli = fakeCli(root);
  try {
    const module = await importGenerated(renderGlobalOpenCodePlugin({
      executable: cli.path, home: join(root, "vault"), workspaceRoots: [workspace],
    }));
    const logs = [];
    const hooks = await module.ContinuityDBGlobalPlugin({
      directory: repo, worktree: "/",
      client: { app: { log: async ({ body }) => logs.push(body) } },
    });
    await hooks["chat.message"](
      { sessionID: "session-1" },
      { parts: [{ type: "text", text: "Continue the billing migration" }] },
    );
    const output = { system: ["base system prompt"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output);
    assert.equal(output.system.length, 1, "plugin must mutate the existing system entry in place");
    assert.match(output.system[0], /ContinuityDB project: service/);
    assert.match(output.system[0], /Use billing-api naming/);
    assert.match(output.system[0], /untrusted evidence/i);
    assert.equal(logs.some((item) => item.level === "error"), false);

    const calls = readFileSync(cli.log, "utf8").trim().split("\n").map(JSON.parse);
    const ensure = calls.find((args) => args[0] === "opencode" && args[1] === "ensure");
    assert.deepEqual(ensure.filter((value) => value === "--workspace-root"), ["--workspace-root"]);
    assert.equal(ensure[ensure.indexOf("--project-dir") + 1], repo);
    const context = calls.find((args) => args[0] === "context");
    assert.equal(context[context.indexOf("--project") + 1], "service");
    assert.equal(context[context.indexOf("--allow-projects") + 1], "service");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global plugin tools are fixed to the derived project and governed capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-tools-"));
  const workspace = join(root, "workspace");
  const repo = join(workspace, "service");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const cli = fakeCli(root);
  try {
    const module = await importGenerated(renderGlobalOpenCodePlugin({
      executable: cli.path, home: join(root, "vault"), workspaceRoots: [workspace], sensitivities: ["public"],
    }));
    const hooks = await module.ContinuityDBGlobalPlugin({
      directory: repo, worktree: "/", client: { app: { log: async () => {} } },
    });
    const config = { permission: { "*": "ask", bash: "deny" } };
    await hooks.config(config);
    assert.equal(config.permission["continuitydb_*"], "allow");
    assert.equal(config.permission.bash, "deny");

    for (const definition of Object.values(hooks.tool)) {
      assert.equal(Object.hasOwn(definition.args, "project_id"), false);
      assert.equal(Object.hasOwn(definition.args, "project"), false);
    }
    const context = { directory: repo, worktree: "/", sessionID: "s", messageID: "m", agent: "plan" };
    const search = await hooks.tool.continuitydb_memory_search.execute({ query: "billing" }, context);
    assert.match(search, /Scoped search result/);
    const saved = await hooks.tool.continuitydb_remember.execute({
      body: "Use billing-api naming for public routes.", kind: "decision", sensitivity: "private",
    }, context);
    assert.match(saved, /memory-1/);
    await hooks.tool.continuitydb_remember.execute({
      body: "Use billing-api naming for public routes.", kind: "decision", sensitivity: "private",
    }, context);
    await assert.rejects(
      hooks.tool.continuitydb_remember.execute({
        body: "SECRET=must-not-store", kind: "decision", sensitivity: "private",
      }, context),
      /secret-looking content rejected/i,
    );

    const calls = readFileSync(cli.log, "utf8").trim().split("\n").map(JSON.parse);
    for (const call of calls.filter((args) => args[0] === "search" || args[0] === "capture")) {
      assert.equal(call[call.indexOf("--project") + 1], "service");
      if (call[0] === "search") assert.equal(call[call.indexOf("--sensitivities") + 1], "public");
    }
    const captures = calls.filter((args) => args[0] === "capture" && args.includes("Use billing-api naming for public routes."));
    assert.equal(captures.length, 2);
    assert.match(captures[0][captures[0].indexOf("--idempotency-key") + 1], /^[a-f0-9]{64}$/);
    assert.equal(
      captures[0][captures[0].indexOf("--idempotency-key") + 1],
      captures[1][captures[1].indexOf("--idempotency-key") + 1],
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global plugin recalls on every fresh system output and deduplicates within one output", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-repeat-recall-"));
  const workspace = join(root, "workspace");
  const repo = join(workspace, "service");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const cli = fakeCli(root);
  try {
    const module = await importGenerated(renderGlobalOpenCodePlugin({
      executable: cli.path, home: join(root, "vault"), workspaceRoots: [workspace], sensitivities: ["public"],
    }));
    const hooks = await module.ContinuityDBGlobalPlugin({
      directory: repo, client: { app: { log: async () => {} } },
    });
    const input = { sessionID: "session-1" };
    await hooks["chat.message"](input, { parts: [{ type: "text", text: "Continue the billing migration" }] });
    for (const output of [{ system: ["base prompt"] }, { system: ["base prompt"] }, { system: [] }]) {
      await Promise.all([
        hooks["experimental.chat.system.transform"](input, output),
        hooks["experimental.chat.system.transform"](input, output),
      ]);
      assert.match(output.system[0], /Use billing-api naming/);
      assert.equal(output.system.join("\n").split("# ContinuityDB project: service").length - 1, 1);
      const before = [...output.system];
      await hooks["experimental.chat.system.transform"](input, output);
      assert.deepEqual(output.system, before);

      output.system.splice(0, output.system.length, "replacement base");
      await hooks["experimental.chat.system.transform"](input, output);
      assert.match(output.system[0], /replacement base.*\n\n# ContinuityDB/);
      assert.match(output.system[0], /Use billing-api naming/);
    }
    const reused = { system: ["base prompt"] };
    await hooks["experimental.chat.system.transform"](input, reused);
    await hooks["chat.message"](input, { parts: [{ type: "text", text: "Review the new naming decision" }] });
    await hooks["experimental.chat.system.transform"](input, reused);
    assert.match(reused.system[0], /Review the new naming decision/);
    assert.doesNotMatch(reused.system[0], /Continue the billing migration/);
    assert.equal(reused.system[0].split("# ContinuityDB project: service").length - 1, 1);
    const calls = readFileSync(cli.log, "utf8").trim().split("\n").map(JSON.parse);
    for (const call of calls.filter((args) => args[0] === "context")) {
      assert.equal(call[call.indexOf("--sensitivities") + 1], "public");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global plugin refreshes bounded context during compaction without storing prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-compact-"));
  const workspace = join(root, "workspace");
  const repo = join(workspace, "service");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const cli = fakeCli(root);
  try {
    const module = await importGenerated(renderGlobalOpenCodePlugin({
      executable: cli.path, home: join(root, "vault"), workspaceRoots: [workspace],
    }));
    const hooks = await module.ContinuityDBGlobalPlugin({
      directory: repo, worktree: "/", client: { app: { log: async () => {} } },
    });
    await hooks["chat.message"]({ sessionID: "s" }, { parts: [{ type: "text", text: "PRIVATE TASK TEXT" }] });
    const output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: "s" }, output);
    assert.match(output.context[0], /Repository convention/);
    const calls = readFileSync(cli.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.some((args) => args[0] === "capture" && args.includes("PRIVATE TASK TEXT")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global plugin renderer rejects unsafe configuration", () => {
  const root = resolve("/tmp/workspace");
  assert.throws(() => renderGlobalOpenCodePlugin({ executable: "continuitydb", home: "/vault", workspaceRoots: [root] }), /absolute executable/i);
  assert.throws(() => renderGlobalOpenCodePlugin({ executable: "/bin/continuitydb", home: "/vault", workspaceRoots: [] }), /workspace root/i);
  assert.throws(() => renderGlobalOpenCodePlugin({ executable: "/bin/continuitydb", home: "/vault", workspaceRoots: [root], sensitivities: ["secret"] }), /sensitivity/i);
});

test("untrusted auxiliary OpenCode instances expose no memory hooks or tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuitydb-opencode-untrusted-"));
  const cli = join(root, "rejecting-continuitydb");
  writeFileSync(cli, `#!/usr/bin/env node
process.stderr.write(JSON.stringify({ error: "project is outside trusted workspace roots" }));
process.exit(1);
`, { mode: 0o755 });
  chmodSync(cli, 0o755);
  try {
    const module = await importGenerated(renderGlobalOpenCodePlugin({
      executable: cli, home: join(root, "vault"), workspaceRoots: [join(root, "trusted")],
    }));
    const logs = [];
    const hooks = await module.ContinuityDBGlobalPlugin({
      directory: join(root, "untrusted"), worktree: "/",
      client: { app: { log: async ({ body }) => logs.push(body) } },
    });
    assert.deepEqual(hooks, {});
    assert.equal(logs.length, 1);
    assert.match(logs[0].message, /outside trusted workspace roots/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
