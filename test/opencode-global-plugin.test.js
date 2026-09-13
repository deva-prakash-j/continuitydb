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
  process.stdout.write(JSON.stringify({ project_id: value("--project"), memories: [{ title: "Repository convention", body: "Use billing-api naming." }] }));
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
  const path = join(process.cwd(), `.opencode-global-plugin-${process.pid}-${Date.now()}-${Math.random()}.mjs`);
  writeFileSync(path, source, { flag: "wx", mode: 0o600 });
  try { return await import(`${pathToFileURL(path).href}?v=${Date.now()}`); }
  finally { rmSync(path, { force: true }); }
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
      directory: repo, worktree: repo,
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
      executable: cli.path, home: join(root, "vault"), workspaceRoots: [workspace],
    }));
    const hooks = await module.ContinuityDBGlobalPlugin({
      directory: repo, worktree: repo, client: { app: { log: async () => {} } },
    });
    const config = { permission: { "*": "ask", bash: "deny" } };
    await hooks.config(config);
    assert.equal(config.permission["continuitydb_*"], "allow");
    assert.equal(config.permission.bash, "deny");

    for (const definition of Object.values(hooks.tool)) {
      assert.equal(Object.hasOwn(definition.args, "project_id"), false);
      assert.equal(Object.hasOwn(definition.args, "project"), false);
    }
    const context = { directory: repo, worktree: repo, sessionID: "s", messageID: "m", agent: "plan" };
    const search = await hooks.tool.continuitydb_memory_search.execute({ query: "billing" }, context);
    assert.match(search, /Scoped search result/);
    const saved = await hooks.tool.continuitydb_remember.execute({
      body: "Use billing-api naming for public routes.", kind: "decision", sensitivity: "private",
    }, context);
    assert.match(saved, /memory-1/);
    await assert.rejects(
      hooks.tool.continuitydb_remember.execute({
        body: "SECRET=must-not-store", kind: "decision", sensitivity: "private",
      }, context),
      /secret-looking content rejected/i,
    );

    const calls = readFileSync(cli.log, "utf8").trim().split("\n").map(JSON.parse);
    for (const call of calls.filter((args) => args[0] === "search" || args[0] === "capture")) {
      assert.equal(call[call.indexOf("--project") + 1], "service");
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
      directory: repo, worktree: repo, client: { app: { log: async () => {} } },
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
