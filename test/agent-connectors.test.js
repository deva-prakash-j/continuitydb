import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  connectAgent,
  connectAgents,
  connectionStatus,
  detectAgents,
  disconnectAgent,
  disconnectAgents,
  setupAgentSummary,
  SUPPORTED_AGENTS,
} from "../src/agent-connectors.js";
import { registerProject } from "../src/project-registry.js";

const CODEX_START_FOR_TEST = "# >>> continuitydb managed configuration >>>";
const CODEX_END_FOR_TEST = "# <<< continuitydb managed configuration <<<";

function clientPaths(project) {
  return {
    codex: join(project, ".codex", "config.toml"),
    claude: join(project, ".mcp.json"),
    opencode: join(project, "opencode.json"),
    cursor: join(project, ".cursor", "mcp.json"),
    copilot: join(project, ".vscode", "mcp.json"),
  };
}

function seedClientFiles(project) {
  const paths = clientPaths(project);
  for (const path of Object.values(paths)) mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(paths.codex, 'model = "gpt-5"\n');
  writeFileSync(paths.claude, '{"keep":"claude"}\n');
  writeFileSync(paths.opencode, '{"keep":"opencode"}\n');
  writeFileSync(paths.cursor, '{"keep":"cursor"}\n');
  writeFileSync(paths.copilot, '{"keep":"copilot"}\n');
  return paths;
}

function contents(paths) {
  return Object.fromEntries(Object.entries(paths).map(([client, path]) => [client, readFileSync(path, "utf8")]));
}

function fixture() {
  const root = join(tmpdir(), `continuitydb-connectors-${process.pid}-${crypto.randomUUID()}`);
  const project = join(root, "project");
  const home = join(root, "vault");
  mkdirSync(project, { recursive: true });
  return { root, project, home };
}

function options(value, apply = true) {
  return {
    projectDir: value.project,
    home: value.home,
    apply,
    binary: "/opt/continuitydb/bin/continuitydb",
    ownerId: "owner-a",
    tenantId: "tenant-a",
    projectId: "service-a",
  };
}

function gitFixture() {
  const value = fixture();
  mkdirSync(join(value.project, ".git"));
  return value;
}

test("nested Git paths use the Git-root basename in connector allowlists", () => {
  const value = gitFixture();
  const nested = join(value.project, "packages", "worker");
  try {
    mkdirSync(nested, { recursive: true });
    const result = connectAgent("codex", {
      ...options({ ...value, project: nested }),
      projectId: undefined,
    });
    const text = readFileSync(result.path, "utf8");
    assert.match(text, /CONTINUITYDB_ALLOWED_PROJECTS = "project"/);
    assert.doesNotMatch(text, /CONTINUITYDB_ALLOWED_PROJECTS = "(?:service-a|worker)"/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("outside Git connect rejects legacy project allowlists before mutation", () => {
  const value = fixture();
  try {
    assert.throws(
      () => connectAgent("codex", { ...options(value), projectId: undefined, projects: ["legacy-project"] }),
      /cannot infer a project identity.*--project <id>/i,
    );
    assert.equal(existsSync(join(value.project, ".codex", "config.toml")), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("singular explicit project identity overrides the Git identity", () => {
  const value = gitFixture();
  try {
    const result = connectAgent("codex", { ...options(value), projectId: "explicit-project" });
    const text = readFileSync(result.path, "utf8");
    assert.match(text, /CONTINUITYDB_ALLOWED_PROJECTS = "explicit-project"/);
    assert.doesNotMatch(text, /CONTINUITYDB_ALLOWED_PROJECTS = "project"/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("agent connectors preview without writing, then apply all clients idempotently", () => {
  const value = fixture();
  try {
    for (const client of SUPPORTED_AGENTS) {
      const preview = connectAgent(client, options(value, false));
      assert.equal(preview.changed, true);
      assert.equal(preview.applied, false);
      assert.equal(existsSync(preview.path), false);
    }
    for (const client of SUPPORTED_AGENTS) {
      const applied = connectAgent(client, options(value));
      assert.equal(applied.changed, true);
      assert.equal(applied.applied, true);
      const repeated = connectAgent(client, options(value));
      assert.equal(repeated.changed, false);
    }
    registerProject(value.home, { id: "service-a", root: value.project, source: "explicit" }, { apply: true });
    assert.deepEqual(connectionStatus(options(value)).map(({ client, connected }) => ({ client, connected })),
      SUPPORTED_AGENTS.map((client) => ({ client, connected: true })));
    const files = [
      join(value.project, ".codex", "config.toml"),
      join(value.project, ".mcp.json"),
      join(value.project, "opencode.json"),
      join(value.project, ".cursor", "mcp.json"),
      join(value.project, ".vscode", "mcp.json"),
    ];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      assert.match(text, /continuitydb/);
      assert.doesNotMatch(text, /Bearer [A-Za-z0-9_-]{12}/);
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("connectors preserve unrelated JSON and TOML content and create immutable backups", () => {
  const value = fixture();
  try {
    mkdirSync(join(value.project, ".codex"), { recursive: true });
    writeFileSync(join(value.project, ".codex", "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(value.project, ".mcp.json"), `${JSON.stringify({ mcpServers: { other: { command: "other" } }, keep: true })}\n`);
    connectAgent("codex", options(value));
    connectAgent("claude", options(value));
    assert.match(readFileSync(join(value.project, ".codex", "config.toml"), "utf8"), /model = "gpt-5"/);
    const claude = JSON.parse(readFileSync(join(value.project, ".mcp.json"), "utf8"));
    assert.equal(claude.keep, true);
    assert.equal(claude.mcpServers.other.command, "other");
    const backupRoot = join(value.home, "backups", "agent-config");
    assert.equal(existsSync(join(backupRoot, "codex")), true);
    assert.equal(existsSync(join(backupRoot, "claude")), true);
    disconnectAgent("codex", options(value));
    disconnectAgent("claude", options(value));
    assert.doesNotMatch(readFileSync(join(value.project, ".codex", "config.toml"), "utf8"), /continuitydb managed/);
    const disconnected = JSON.parse(readFileSync(join(value.project, ".mcp.json"), "utf8"));
    assert.equal(disconnected.keep, true);
    assert.equal(disconnected.mcpServers.other.command, "other");
    assert.equal(disconnected.mcpServers.continuitydb, undefined);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Codex and OpenCode share reference-aware AGENTS policy ownership", () => {
  const value = fixture();
  const agents = join(value.project, "AGENTS.md");
  const userRules = "# User rules\n\nPreserve this exactly.  \n";
  try {
    writeFileSync(agents, userRules);
    connectAgent("codex", options(value));
    assert.match(readFileSync(agents, "utf8"), /consumers: codex/);

    connectAgent("opencode", options(value));
    const shared = readFileSync(agents, "utf8");
    assert.match(shared, /consumers: codex,opencode/);
    assert.match(shared, /memory_context_pack/);
    assert.equal(shared.startsWith(userRules), true);

    disconnectAgent("codex", options(value));
    const oneConsumer = readFileSync(agents, "utf8");
    assert.match(oneConsumer, /consumers: opencode/);
    assert.match(oneConsumer, /memory_context_pack/);
    assert.equal(oneConsumer.startsWith(userRules), true);

    disconnectAgent("opencode", options(value));
    assert.equal(readFileSync(agents, "utf8"), userRules);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("OpenCode installs complete plugin+policy assets transactionally and idempotently", () => {
  const value = fixture();
  const config = join(value.project, "opencode.json");
  const plugin = join(value.project, ".opencode", "plugins", "continuitydb.js");
  const agents = join(value.project, "AGENTS.md");
  const original = '{"theme":"user-theme","mcp":{"other":{"type":"remote","url":"https://other.example/mcp"}}}\r\n';
  try {
    writeFileSync(config, original);
    writeFileSync(agents, "# User rules\n");
    const preview = connectAgent("opencode", options(value, false));
    assert.equal(preview.recall_mode, "plugin+policy");
    assert.equal(preview.capture_mode, "explicit-governed");
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.assets.map((asset) => asset.path), [config, plugin, agents]);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(existsSync(plugin), false);

    const applied = connectAgent("opencode", options(value));
    assert.equal(applied.applied, true);
    assert.equal(applied.verified, true);
    assert.equal(applied.assets.length, 3);
    assert.deepEqual(applied.assets.map((asset) => asset.kind), ["mcp", "plugin", "policy"]);
    const parsed = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(parsed.theme, "user-theme");
    assert.equal(parsed.mcp.other.url, "https://other.example/mcp");
    assert.equal(parsed.mcp.continuitydb.type, "local");
    assert.deepEqual(parsed.plugin, ["./.opencode/plugins/continuitydb.js"]);
    assert.match(readFileSync(plugin, "utf8"), /experimental\.session\.compacting/);
    assert.match(readFileSync(agents, "utf8"), /Recall mode: `plugin\+policy`/);

    const bytes = [config, plugin, agents].map((path) => readFileSync(path, "utf8"));
    const repeated = connectAgent("opencode", options(value));
    assert.equal(repeated.changed, false);
    assert.deepEqual([config, plugin, agents].map((path) => readFileSync(path, "utf8")), bytes);

    const removed = disconnectAgent("opencode", options(value));
    assert.equal(removed.verified, true);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(existsSync(plugin), false);
    assert.equal(readFileSync(agents, "utf8"), "# User rules\n");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("OpenCode generated local plugin embeds the exact custom executable path", () => {
  const value = fixture();
  const binary = join(value.root, "custom bin 'quoted' \\path", "continuity db 'hook' \\binary");
  try {
    const result = connectAgent("opencode", { ...options(value), binary });
    const plugin = result.assets.find((asset) => asset.kind === "plugin");
    const source = readFileSync(plugin.path, "utf8");
    assert.match(source, new RegExp(JSON.stringify(binary).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(source, /execFile\("continuitydb"/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("OpenCode plugin write failure rolls back config and leaves policy untouched", () => {
  const value = fixture();
  const config = join(value.project, "opencode.json");
  const plugin = join(value.project, ".opencode", "plugins", "continuitydb.js");
  const agents = join(value.project, "AGENTS.md");
  const originalConfig = "  \r\n";
  const originalAgents = "# Existing rules\n";
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    writeFileSync(config, originalConfig);
    writeFileSync(agents, originalAgents);
    assert.throws(() => connectAgent("opencode", {
      ...options(value),
      _testBeforeReplace: ({ path }) => { if (path === plugin) throw new Error("injected plugin write failure"); },
    }), /injected plugin write failure/);
    assert.equal(readFileSync(config, "utf8"), originalConfig);
    assert.equal(existsSync(plugin), false);
    assert.equal(readFileSync(agents, "utf8"), originalAgents);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("OpenCode preflight rejects unmanaged or symlinked plugin assets before config mutation", () => {
  for (const setup of [
    (value, plugin) => { mkdirSync(join(value.project, ".opencode", "plugins"), { recursive: true }); writeFileSync(plugin, "// user plugin\n"); },
    (value, plugin) => { mkdirSync(join(value.project, ".opencode", "plugins"), { recursive: true }); const target = join(value.root, "plugin.js"); writeFileSync(target, "// target\n"); symlinkSync(target, plugin); },
  ]) {
    const value = fixture();
    const config = join(value.project, "opencode.json");
    const plugin = join(value.project, ".opencode", "plugins", "continuitydb.js");
    const original = '{"keep":true}\n';
    try {
      writeFileSync(config, original);
      setup(value, plugin);
      assert.throws(() => connectAgent("opencode", options(value)), /(unmanaged OpenCode plugin|regular file, not a symlink)/i);
      assert.equal(readFileSync(config, "utf8"), original);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("OpenCode ownership fingerprints fail closed on plugin or generated config drift", () => {
  for (const drift of ["plugin", "config"]) {
    const value = fixture();
    const config = join(value.project, "opencode.json");
    const plugin = join(value.project, ".opencode", "plugins", "continuitydb.js");
    try {
      connectAgent("opencode", options(value));
      const path = drift === "plugin" ? plugin : config;
      writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()} \n`);
      const before = [config, plugin, join(value.project, "AGENTS.md")].map((item) => readFileSync(item, "utf8"));
      assert.throws(() => connectAgent("opencode", options(value)), /OpenCode .*ownership fingerprint mismatch/);
      assert.deepEqual([config, plugin, join(value.project, "AGENTS.md")].map((item) => readFileSync(item, "utf8")), before);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Codex and Copilot install complete policy-led adapters with truthful asset results", () => {
  const value = fixture();
  const agents = join(value.project, "AGENTS.md");
  const copilotInstructions = join(value.project, ".github", "copilot-instructions.md");
  const userAgents = "# Repository agent rules\n\nKeep this byte-for-byte.  \n";
  const userCopilot = "# Existing Copilot rules\n\nKeep this too.  \n";
  try {
    writeFileSync(agents, userAgents);
    mkdirSync(join(value.project, ".github"));
    writeFileSync(copilotInstructions, userCopilot);

    const preview = connectAgents(["codex", "copilot"], options(value, false));
    assert.deepEqual(preview.map((item) => item.client), ["codex", "copilot"]);
    for (const result of preview) {
      assert.equal(result.recall_mode, "policy-led");
      assert.equal(result.capture_mode, "explicit-governed");
      assert.equal(result.applied, false);
      assert.equal(result.verified, false);
      assert.equal(result.assets.length, 2);
      assert.equal(result.assets.every((asset) => asset.applied === false), true);
    }
    assert.equal(readFileSync(agents, "utf8"), userAgents);
    assert.equal(readFileSync(copilotInstructions, "utf8"), userCopilot);

    const applied = connectAgents(["codex", "copilot"], options(value));
    for (const result of applied) {
      assert.equal(result.applied, true);
      assert.equal(result.verified, true);
      assert.equal(result.assets.length, 2);
      assert.equal(result.assets.every((asset) => asset.applied && asset.verified), true);
    }
    assert.deepEqual(applied[0].assets.map((asset) => asset.path), [
      join(value.project, ".codex", "config.toml"),
      agents,
    ]);
    assert.deepEqual(applied[1].assets.map((asset) => asset.path), [
      join(value.project, ".vscode", "mcp.json"),
      copilotInstructions,
    ]);
    assert.match(readFileSync(agents, "utf8"), /memory_context_pack/);
    assert.match(readFileSync(copilotInstructions, "utf8"), /explicitly asks/i);
    assert.equal(readFileSync(agents, "utf8").startsWith(userAgents), true);
    assert.equal(readFileSync(copilotInstructions, "utf8").startsWith(userCopilot), true);

    const beforeRepeat = {
      agents: readFileSync(agents, "utf8"),
      copilot: readFileSync(copilotInstructions, "utf8"),
    };
    const repeated = connectAgents(["codex", "copilot"], options(value));
    assert.equal(repeated.every((item) => item.changed === false && item.verified), true);
    assert.equal(readFileSync(agents, "utf8"), beforeRepeat.agents);
    assert.equal(readFileSync(copilotInstructions, "utf8"), beforeRepeat.copilot);

    const disconnected = [
      disconnectAgent("codex", options(value)),
      disconnectAgent("copilot", options(value)),
    ];
    assert.equal(disconnected.every((item) => item.applied && item.verified), true);
    assert.equal(readFileSync(agents, "utf8"), userAgents);
    assert.equal(readFileSync(copilotInstructions, "utf8"), userCopilot);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Claude and Cursor install complete lifecycle adapters with fixed project scope", () => {
  const value = fixture();
  const claudePolicy = join(value.project, "CLAUDE.md");
  const claudeSettings = join(value.project, ".claude", "settings.json");
  const cursorHooks = join(value.project, ".cursor", "hooks.json");
  const cursorRule = join(value.project, ".cursor", "rules", "continuitydb.mdc");
  try {
    writeFileSync(claudePolicy, "# Existing Claude instructions\n");
    mkdirSync(join(value.project, ".claude"));
    writeFileSync(claudeSettings, '{"permissions":{"allow":["Read"]},"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}\n');
    mkdirSync(join(value.project, ".cursor"));
    writeFileSync(cursorHooks, '{"version":1,"hooks":{"beforeSubmitPrompt":[{"command":"user-hook"}]},"keep":true}\n');

    const preview = connectAgents(["claude", "cursor"], options(value, false));
    assert.deepEqual(preview.map((item) => item.assets.length), [3, 3]);
    assert.deepEqual(preview.map((item) => item.recall_mode), ["hook-enforced", "hook+policy"]);
    assert.equal(preview.every((item) => item.capture_mode === "explicit-governed"), true);
    assert.match(preview[1].limitations.join(" "), /read-only cloud/i);
    assert.equal(existsSync(cursorRule), false);

    const applied = connectAgents(["claude", "cursor"], options(value));
    assert.equal(applied.every((item) => item.applied && item.verified), true);
    assert.deepEqual(applied[0].assets.map((asset) => asset.path), [
      join(value.project, ".mcp.json"), claudeSettings, claudePolicy,
    ]);
    assert.deepEqual(applied[1].assets.map((asset) => asset.path), [
      join(value.project, ".cursor", "mcp.json"), cursorHooks, cursorRule,
    ]);

    const claude = JSON.parse(readFileSync(claudeSettings, "utf8"));
    assert.equal(claude.permissions.allow[0], "Read");
    assert.equal(claude.hooks.UserPromptSubmit[0].hooks[0].command, "user-hook");
    const claudeStart = claude.hooks.SessionStart[0].hooks[0];
    assert.equal(claudeStart.command, "/opt/continuitydb/bin/continuitydb");
    assert.deepEqual(claudeStart.args.slice(0, 5), ["hook", "session-start", "--client", "claude", "--project"]);
    assert.ok(claudeStart.args.includes("service-a"));
    assert.ok(claudeStart.args.includes(value.home));
    assert.deepEqual(claudeStart.args.slice(-8), [
      "--tenant-id", "tenant-a", "--owner-id", "owner-a", "--agent-id", "claude",
      "--allowed-sensitivities", "public,private",
    ]);
    assert.doesNotMatch(JSON.stringify({ SessionStart: claude.hooks.SessionStart, Stop: claude.hooks.Stop }), /prompt|transcript/i);
    assert.match(readFileSync(claudePolicy, "utf8"), /Project scope: `service-a`/);

    const cursor = JSON.parse(readFileSync(cursorHooks, "utf8"));
    assert.equal(cursor.keep, true);
    assert.equal(cursor.hooks.beforeSubmitPrompt[0].command, "user-hook");
    assert.match(cursor.hooks.sessionStart[0].command, /hook session-start --client cursor/);
    assert.match(cursor.hooks.sessionStart[0].command, /--project service-a/);
    assert.match(cursor.hooks.sessionStart[0].command, /--home/);
    assert.doesNotMatch(JSON.stringify({ sessionStart: cursor.hooks.sessionStart, stop: cursor.hooks.stop }), /prompt|transcript/i);
    assert.match(readFileSync(cursorRule, "utf8"), /untrusted evidence/i);

    const beforeRerun = applied.flatMap((item) => item.assets).map((asset) => readFileSync(asset.path, "utf8"));
    const rerun = connectAgents(["claude", "cursor"], options(value));
    assert.equal(rerun.every((item) => !item.changed && item.verified), true);
    assert.deepEqual(rerun.flatMap((item) => item.assets).map((asset) => readFileSync(asset.path, "utf8")), beforeRerun);

    disconnectAgent("claude", options(value));
    disconnectAgent("cursor", options(value));
    assert.equal(readFileSync(claudePolicy, "utf8"), "# Existing Claude instructions\n");
    assert.equal(JSON.parse(readFileSync(claudeSettings, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command, "user-hook");
    assert.equal(JSON.parse(readFileSync(cursorHooks, "utf8")).hooks.beforeSubmitPrompt[0].command, "user-hook");
    assert.equal(existsSync(cursorRule), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("fresh Claude and Cursor disconnect removes owned files and empty created directories", () => {
  for (const client of ["claude", "cursor"]) {
    const value = fixture();
    try {
      const connected = connectAgent(client, options(value));
      assert.equal(connected.assets.every((asset) => existsSync(asset.path)), true);
      disconnectAgent(client, options(value));
      assert.equal(connected.assets.every((asset) => !existsSync(asset.path)), true);
      if (client === "claude") assert.equal(existsSync(join(value.project, ".claude")), false);
      else {
        assert.equal(existsSync(join(value.project, ".cursor", "rules")), false);
        assert.equal(existsSync(join(value.project, ".cursor")), false);
      }
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Claude and Cursor disconnect restores preexisting user JSON and instructions byte-exact", () => {
  for (const client of ["claude", "cursor"]) {
    const value = fixture();
    const paths = client === "claude" ? {
      mcp: join(value.project, ".mcp.json"),
      hooks: join(value.project, ".claude", "settings.json"),
      policy: join(value.project, "CLAUDE.md"),
    } : {
      mcp: join(value.project, ".cursor", "mcp.json"),
      hooks: join(value.project, ".cursor", "hooks.json"),
      policy: null,
    };
    const originals = {
      mcp: '{\r\n  "keep" : "mcp-spacing",\r\n  "mcpServers" : { "other" : { "command" : "other" } }\r\n}\r\n',
      hooks: client === "claude"
        ? '{\r\n  "permissions" : { "allow" : ["Read"] },\r\n  "hooks" : { "UserPromptSubmit" : [ { "hooks" : [{"type":"command","command":"user"}] } ] }\r\n}\r\n'
        : '{\r\n  "version" : 1,\r\n  "hooks" : { "beforeSubmitPrompt" : [ { "command" : "user" } ] },\r\n  "keep" : true\r\n}\r\n',
      policy: "# Existing Claude policy\n\nKeep bytes.  \n",
    };
    try {
      mkdirSync(join(paths.mcp, ".."), { recursive: true });
      mkdirSync(join(paths.hooks, ".."), { recursive: true });
      writeFileSync(paths.mcp, originals.mcp);
      writeFileSync(paths.hooks, originals.hooks);
      if (paths.policy) writeFileSync(paths.policy, originals.policy);
      connectAgent(client, options(value));
      disconnectAgent(client, options(value));
      assert.equal(readFileSync(paths.mcp, "utf8"), originals.mcp);
      assert.equal(readFileSync(paths.hooks, "utf8"), originals.hooks);
      if (paths.policy) assert.equal(readFileSync(paths.policy, "utf8"), originals.policy);
      assert.equal(existsSync(join(paths.hooks, "..")), true);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Claude and Cursor ownership topology fails closed on post-connect file drift", () => {
  for (const client of ["claude", "cursor"]) {
    const value = fixture();
    try {
      const connected = connectAgent(client, options(value));
      const hooks = connected.assets.find((asset) => asset.kind === "lifecycle").path;
      const mcp = connected.assets.find((asset) => asset.kind === "mcp").path;
      const policy = connected.assets.find((asset) => asset.kind === "policy").path;
      const drifted = `${readFileSync(hooks, "utf8").trimEnd()} \n`;
      writeFileSync(hooks, drifted);
      const before = [mcp, hooks, policy].map((path) => readFileSync(path, "utf8"));
      assert.throws(() => connectAgent(client, options(value)), /hooks file ownership fingerprint mismatch/);
      assert.throws(() => disconnectAgent(client, options(value)), /hooks file ownership fingerprint mismatch/);
      assert.deepEqual([mcp, hooks, policy].map((path) => readFileSync(path, "utf8")), before);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Cursor rule preserves preexisting emptiness and appended user content on disconnect", () => {
  for (const preexisting of [false, true]) {
    const value = fixture();
    const rule = join(value.project, ".cursor", "rules", "continuitydb.mdc");
    try {
      if (preexisting) {
        mkdirSync(join(rule, ".."), { recursive: true });
        writeFileSync(rule, "");
      }
      connectAgent("cursor", options(value));
      const appended = "\n# User-added Cursor rule\nPreserve this exactly.  \n";
      writeFileSync(rule, `${readFileSync(rule, "utf8")}${appended}`);
      disconnectAgent("cursor", options(value));
      assert.equal(readFileSync(rule, "utf8"), appended);
      if (!preexisting) assert.equal(existsSync(join(value.project, ".cursor")), true);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  for (const original of ["", "---\ndescription: User rule\nalwaysApply: true\n---\n# Existing rule\n"]) {
    const value = fixture();
    const rule = join(value.project, ".cursor", "rules", "continuitydb.mdc");
    try {
      mkdirSync(join(rule, ".."), { recursive: true });
      writeFileSync(rule, original);
      connectAgent("cursor", options(value));
      disconnectAgent("cursor", options(value));
      assert.equal(existsSync(rule), true);
      assert.equal(readFileSync(rule, "utf8"), original);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  const value = fixture();
  const rule = join(value.project, ".cursor", "rules", "continuitydb.mdc");
  try {
    connectAgent("cursor", options(value));
    const drifted = readFileSync(rule, "utf8").replace("compact durable claim", "drifted durable claim");
    writeFileSync(rule, drifted);
    assert.throws(() => disconnectAgent("cursor", options(value)), /Cursor rule ownership fingerprint mismatch/);
    assert.equal(readFileSync(rule, "utf8"), drifted);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("lifecycle connector identity and sensitivity inputs are validated before writes", () => {
  const value = fixture();
  try {
    assert.throws(() => connectAgent("claude", { ...options(value), tenantId: "bad tenant" }), /tenant_id/);
    assert.throws(() => connectAgent("cursor", { ...options(value), ownerId: "bad owner" }), /owner_id/);
    assert.throws(() => connectAgent("claude", { ...options(value), sensitivities: ["private", "unknown"] }), /invalid allowed sensitivity/);
    assert.equal(existsSync(join(value.project, ".mcp.json")), false);
    assert.equal(existsSync(join(value.project, ".cursor")), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Claude and Cursor adapter preflight rejects malformed assets and rolls back injected writes", () => {
  for (const [client, relativePath] of [
    ["claude", join(".claude", "settings.json")],
    ["cursor", join(".cursor", "hooks.json")],
  ]) {
    const value = fixture();
    try {
      mkdirSync(join(value.project, relativePath, ".."), { recursive: true });
      writeFileSync(join(value.project, relativePath), '{"hooks":[]}\n');
      assert.throws(() => connectAgent(client, options(value)), /namespace hooks must be a JSON object/);
      assert.equal(readFileSync(join(value.project, relativePath), "utf8"), '{"hooks":[]}\n');
      assert.equal(existsSync(clientPaths(value.project)[client]), false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  for (const [client, relativePath, malformed] of [
    ["claude", "CLAUDE.md", "<!-- >>> continuitydb managed policy >>>\nmissing end\n"],
    ["cursor", join(".cursor", "rules", "continuitydb.mdc"), "<!-- >>> continuitydb managed policy >>>\nmissing end\n"],
  ]) {
    const value = fixture();
    try {
      const path = join(value.project, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, malformed);
      assert.throws(() => connectAgent(client, options(value)), /invalid ContinuityDB managed/);
      assert.equal(readFileSync(path, "utf8"), malformed);
      assert.equal(existsSync(clientPaths(value.project)[client]), false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  for (const client of ["claude", "cursor"]) {
    const value = fixture();
    try {
      const mcp = clientPaths(value.project)[client];
      mkdirSync(join(mcp, ".."), { recursive: true });
      writeFileSync(mcp, '{"mcpServers":{"continuitydb":{"command":"user-owned"}}}\n');
      assert.throws(() => connectAgent(client, options(value)), /unmanaged .*continuitydb server/i);
      assert.throws(() => disconnectAgent(client, options(value)), /unmanaged .*continuitydb server/i);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  const value = fixture();
  const originalMcp = '{"keep":"claude"}\n';
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    writeFileSync(join(value.project, ".mcp.json"), originalMcp);
    assert.throws(() => connectAgent("claude", {
      ...options(value),
      _testBeforeReplace: ({ path }) => {
        if (path.endsWith(join(".claude", "settings.json"))) throw new Error("injected lifecycle write failure");
      },
    }), /injected lifecycle write failure/);
    assert.equal(readFileSync(join(value.project, ".mcp.json"), "utf8"), originalMcp);
    assert.equal(existsSync(join(value.project, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(value.project, "CLAUDE.md")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot policy markers and unmanaged MCP conflicts fail closed before any adapter write", () => {
  const malformedPolicies = [
    ["<!-- >>> continuitydb managed policy >>>\nmissing end\n", /invalid ContinuityDB managed text block/],
    ["<!-- <<< continuitydb managed policy <<< -->\n", /invalid ContinuityDB managed text block/],
    [
      "<!-- >>> continuitydb managed policy >>>\n<!-- >>> continuitydb managed policy >>>\n<!-- <<< continuitydb managed policy <<< -->",
      /invalid ContinuityDB managed text block/,
    ],
    [
      "<!-- >>> continuitydb managed policy >>> consumers: codex\nProject scope: `service-a`.\n<!-- <<< continuitydb managed policy <<< -->",
      /invalid ContinuityDB managed copilot policy metadata/,
    ],
  ];
  for (const [original, expected] of malformedPolicies) {
    const value = fixture();
    const instructions = join(value.project, ".github", "copilot-instructions.md");
    try {
      mkdirSync(join(value.project, ".github"));
      writeFileSync(instructions, original);
      assert.throws(() => connectAgent("copilot", options(value)), expected);
      assert.equal(readFileSync(instructions, "utf8"), original);
      assert.equal(existsSync(join(value.project, ".vscode", "mcp.json")), false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  const value = fixture();
  const mcp = join(value.project, ".vscode", "mcp.json");
  try {
    mkdirSync(join(value.project, ".vscode"));
    const original = '{"servers":{"continuitydb":{"command":"user-owned"}},"keep":true}\n';
    writeFileSync(mcp, original);
    assert.throws(() => connectAgent("copilot", options(value)), /unmanaged Copilot continuitydb server/);
    assert.equal(readFileSync(mcp, "utf8"), original);
    assert.equal(existsSync(join(value.project, ".github", "copilot-instructions.md")), false);
    assert.throws(() => disconnectAgent("copilot", options(value)), /unmanaged Copilot continuitydb server/);
    assert.equal(readFileSync(mcp, "utf8"), original);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot never infers MCP ownership from a generated-looking server shape", () => {
  const value = fixture();
  const mcp = join(value.project, ".vscode", "mcp.json");
  const original = '{\r\n  "servers": {\r\n    "continuitydb": {\r\n      "type": "stdio",\r\n      "command": "/user/continuitydb",\r\n      "args": ["mcp", "--home", "/user/vault"],\r\n      "env": {\r\n        "CONTINUITYDB_AGENT_ID": "copilot",\r\n        "CONTINUITYDB_ALLOWED_PROJECTS": "service-a"\r\n      }\r\n    }\r\n  },\r\n  "keep": "user-owned"\r\n}\r\n';
  try {
    mkdirSync(join(value.project, ".vscode"));
    writeFileSync(mcp, original);
    assert.throws(() => connectAgent("copilot", options(value)), /unmanaged Copilot continuitydb server/);
    assert.equal(readFileSync(mcp, "utf8"), original);
    assert.equal(existsSync(join(value.project, ".github", "copilot-instructions.md")), false);
    assert.throws(() => disconnectAgent("copilot", options(value)), /unmanaged Copilot continuitydb server/);
    assert.equal(readFileSync(mcp, "utf8"), original);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("connector revalidates committed assets and preserves a direct writer between asset commits", () => {
  const value = fixture();
  const previousNodeEnv = process.env.NODE_ENV;
  const mcp = join(value.project, ".vscode", "mcp.json");
  const policy = join(value.project, ".github", "copilot-instructions.md");
  const external = '{"external":"writer-wins"}\n';
  try {
    process.env.NODE_ENV = "test";
    assert.throws(() => connectAgent("copilot", {
      ...options(value),
      _testAfterCommit: ({ committed }) => {
        if (committed === 1) writeFileSync(mcp, external, { mode: 0o600 });
      },
    }), /(changed after commit verification|rollback was incomplete)/);
    assert.equal(readFileSync(mcp, "utf8"), external);
    assert.equal(existsSync(policy), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot JSON connect and disconnect are byte-reversible and remove connector-created containers", () => {
  const originals = [
    '{\r\n  "keep" : "spacing",\r\n  "servers" : {\r\n    "other" : { "command" : "other" }\r\n  }\r\n}\r\n',
    '{\r\n\t"keep": true\r\n}\r\n',
    '{\r\n  "servers" : {  },\r\n  "keep": true\r\n}\r\n',
  ];
  for (const original of originals) {
    const value = fixture();
    const mcp = join(value.project, ".vscode", "mcp.json");
    try {
      mkdirSync(join(value.project, ".vscode"));
      writeFileSync(mcp, original);
      connectAgent("copilot", options(value));
      assert.notEqual(readFileSync(mcp, "utf8"), original);
      disconnectAgent("copilot", options(value));
      assert.equal(readFileSync(mcp, "utf8"), original);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  const value = fixture();
  const mcp = join(value.project, ".vscode", "mcp.json");
  try {
    connectAgent("copilot", options(value));
    assert.equal(existsSync(mcp), true);
    disconnectAgent("copilot", options(value));
    assert.equal(existsSync(mcp), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot reconnect recomputes stale ownership when the managed server is absent", () => {
  const cases = [
    {
      name: "recreated user document",
      current: "{  }\r\n",
      ownership: /document=existing; namespace=created/,
    },
    {
      name: "recreated whitespace-only document",
      current: "\r\n\t  ",
      ownership: /document=empty; namespace=created/,
    },
    {
      name: "still missing document",
      current: null,
      ownership: /document=missing; namespace=created/,
    },
    {
      name: "user-created namespace",
      current: '{\r\n  "servers": {\r\n    "other": { "command": "user" }\r\n  }\r\n}\r\n',
      ownership: /document=existing; namespace=existing/,
    },
    {
      name: "pre-existing empty namespace",
      current: '{\r\n  "servers" : {  }\r\n}\r\n',
      ownership: /document=existing; namespace=existing/,
    },
  ];
  for (const item of cases) {
    const value = fixture();
    const mcp = join(value.project, ".vscode", "mcp.json");
    const policy = join(value.project, ".github", "copilot-instructions.md");
    try {
      connectAgent("copilot", options(value));
      rmSync(mcp);
      if (item.current !== null) writeFileSync(mcp, item.current);

      connectAgent("copilot", options(value));
      assert.match(readFileSync(policy, "utf8"), item.ownership, item.name);
      disconnectAgent("copilot", options(value));
      if (item.current === null) {
        assert.equal(existsSync(mcp), false, item.name);
      } else {
        assert.equal(readFileSync(mcp, "utf8"), item.current, item.name);
      }
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Copilot ownership fingerprint rejects stale or changed MCP entries", () => {
  const userOwned = '{\r\n  "servers": {\r\n    "continuitydb": {"type":"stdio","command":"user-owned","args":["mcp"]}\r\n  },\r\n  "keep": true\r\n}\r\n';
  for (const action of ["connect", "disconnect"]) {
    const value = fixture();
    const mcp = join(value.project, ".vscode", "mcp.json");
    const policy = join(value.project, ".github", "copilot-instructions.md");
    try {
      connectAgent("copilot", options(value));
      const policyBefore = readFileSync(policy, "utf8");
      rmSync(mcp);
      writeFileSync(mcp, userOwned);
      assert.throws(
        () => action === "connect"
          ? connectAgent("copilot", options(value))
          : disconnectAgent("copilot", options(value)),
        /Copilot MCP ownership fingerprint mismatch/,
        action,
      );
      assert.equal(readFileSync(mcp, "utf8"), userOwned, action);
      assert.equal(readFileSync(policy, "utf8"), policyBefore, action);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  for (const changedField of ["command", "args", "env"]) {
    const value = fixture();
    const mcp = join(value.project, ".vscode", "mcp.json");
    try {
      connectAgent("copilot", options(value));
      const changed = JSON.parse(readFileSync(mcp, "utf8"));
      if (changedField === "command") changed.servers.continuitydb.command = "/user/replacement";
      if (changedField === "args") changed.servers.continuitydb.args = ["mcp", "--home", "/user/replacement"];
      if (changedField === "env") changed.servers.continuitydb.env.CONTINUITYDB_OWNER_ID = "user-replacement";
      const changedBytes = `${JSON.stringify(changed, null, 2)}\n`;
      writeFileSync(mcp, changedBytes);
      assert.throws(
        () => connectAgent("copilot", options(value)),
        /Copilot MCP ownership fingerprint mismatch/,
        changedField,
      );
      assert.equal(readFileSync(mcp, "utf8"), changedBytes, changedField);
      assert.throws(
        () => disconnectAgent("copilot", options(value)),
        /Copilot MCP ownership fingerprint mismatch/,
        changedField,
      );
      assert.equal(readFileSync(mcp, "utf8"), changedBytes, changedField);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  const value = fixture();
  const mcp = join(value.project, ".vscode", "mcp.json");
  const policy = join(value.project, ".github", "copilot-instructions.md");
  try {
    const first = connectAgent("copilot", options(value));
    const managed = readFileSync(mcp, "utf8");
    assert.match(readFileSync(policy, "utf8"), /entry_sha256=[a-f0-9]{64}/);
    const repeated = connectAgent("copilot", options(value));
    assert.equal(repeated.changed, false);
    assert.equal(readFileSync(mcp, "utf8"), managed);
    assert.equal(first.verified && repeated.verified, true);
    disconnectAgent("copilot", options(value));
    assert.equal(existsSync(mcp), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot ownership fingerprint accepts semantic JSON reformatting and preserves unrelated bytes", () => {
  const value = fixture();
  const mcp = join(value.project, ".vscode", "mcp.json");
  const beforeManagedProperty = '{\r\n  "unrelated" : { "spacing" : true },\r\n  "servers" : {\r\n    "other" : { "command" : "user" }';
  const managedPropertyPrefix = ',\r\n    "continuitydb" : ';
  const afterManagedProperty = '\r\n  },\r\n  "tail" : "keep exactly"  \r\n}\r\n';
  const reorderRecursively = (item) => {
    if (Array.isArray(item)) return item.map(reorderRecursively);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).reverse()
      .map(([key, entry]) => [key, reorderRecursively(entry)]));
  };
  try {
    mkdirSync(join(value.project, ".vscode"));
    writeFileSync(mcp, `${beforeManagedProperty}${afterManagedProperty}`);
    connectAgent("copilot", options(value));
    const generatedServer = JSON.parse(readFileSync(mcp, "utf8")).servers.continuitydb;
    const reformattedServer = JSON.stringify(reorderRecursively(generatedServer), null, 4);
    const reformatted = `${beforeManagedProperty}${managedPropertyPrefix}${reformattedServer}${afterManagedProperty}`;
    writeFileSync(mcp, reformatted);

    const reconnected = connectAgent("copilot", options(value));
    assert.equal(reconnected.applied && reconnected.verified, true);
    assert.equal(
      readFileSync(mcp, "utf8"),
      `${beforeManagedProperty}${managedPropertyPrefix}${JSON.stringify(generatedServer)}${afterManagedProperty}`,
    );

    writeFileSync(mcp, reformatted);
    const disconnected = disconnectAgent("copilot", options(value));
    assert.equal(disconnected.applied && disconnected.verified, true);
    assert.equal(readFileSync(mcp, "utf8"), `${beforeManagedProperty}${afterManagedProperty}`);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot adapter rejects cross-project policy replacement and rolls back MCP on policy races", () => {
  const value = fixture();
  const previousNodeEnv = process.env.NODE_ENV;
  const mcp = join(value.project, ".vscode", "mcp.json");
  const instructions = join(value.project, ".github", "copilot-instructions.md");
  try {
    connectAgent("copilot", options(value));
    const originalMcp = readFileSync(mcp, "utf8");
    const originalInstructions = readFileSync(instructions, "utf8");
    assert.throws(
      () => connectAgent("copilot", { ...options(value), projectId: "other-service" }),
      /managed Copilot policy belongs to project service-a, not other-service/,
    );
    assert.equal(readFileSync(mcp, "utf8"), originalMcp);
    assert.equal(readFileSync(instructions, "utf8"), originalInstructions);

    process.env.NODE_ENV = "test";
    const external = "# Concurrent Copilot edit\n";
    writeFileSync(
      instructions,
      originalInstructions.replace("compact durable claim", "drifted compact durable claim"),
    );
    assert.throws(() => connectAgent("copilot", {
      ...options(value),
      binary: "/opt/continuitydb/bin/continuitydb-v2",
      _testBeforeReplace: ({ path }) => {
        if (path === instructions) writeFileSync(instructions, external, { mode: 0o600 });
      },
    }), /configuration changed before atomic replacement/);
    assert.equal(readFileSync(mcp, "utf8"), originalMcp);
    assert.equal(readFileSync(instructions, "utf8"), external);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Copilot policy target and parent symlinks fail closed", () => {
  for (const symlinkParent of [false, true]) {
    const value = fixture();
    const outside = join(value.root, "outside");
    const instructions = join(value.project, ".github", "copilot-instructions.md");
    try {
      mkdirSync(outside);
      if (symlinkParent) {
        symlinkSync(outside, join(value.project, ".github"));
      } else {
        mkdirSync(join(value.project, ".github"));
        const outsideFile = join(outside, "instructions.md");
        writeFileSync(outsideFile, "outside\n");
        symlinkSync(outsideFile, instructions);
      }
      assert.throws(() => connectAgent("copilot", options(value)), /(regular file, not a symlink|real directory)/);
      assert.equal(existsSync(join(value.project, ".vscode", "mcp.json")), false);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("shared policy preview is write-free and malformed markers fail before MCP mutation", () => {
  const value = fixture();
  const agents = join(value.project, "AGENTS.md");
  try {
    const preview = connectAgent("codex", options(value, false));
    assert.equal(preview.applied, false);
    assert.equal(existsSync(agents), false);

    const malformed = "<!-- >>> continuitydb managed policy >>>\nmissing end\n";
    writeFileSync(agents, malformed);
    assert.throws(() => connectAgent("codex", options(value)), /invalid ContinuityDB managed text block/);
    assert.equal(readFileSync(agents, "utf8"), malformed);
    assert.equal(existsSync(join(value.project, ".codex", "config.toml")), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("shared policy write conflicts preserve the external edit and roll back MCP configuration", () => {
  const value = fixture();
  const previousNodeEnv = process.env.NODE_ENV;
  const agents = join(value.project, "AGENTS.md");
  const external = "# Rules changed concurrently\n";
  try {
    process.env.NODE_ENV = "test";
    writeFileSync(agents, "# Original rules\n");
    assert.throws(() => connectAgent("codex", {
      ...options(value),
      _testBeforeReplace: ({ path }) => {
        if (path === agents) writeFileSync(agents, external, { mode: 0o600 });
      },
    }), /configuration changed before atomic replacement/);
    assert.equal(readFileSync(agents, "utf8"), external);
    assert.equal(existsSync(join(value.project, ".codex", "config.toml")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("connectors reject symlinked configuration parents", () => {
  const value = fixture();
  try {
    const outside = join(value.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(value.project, ".cursor"));
    assert.throws(() => connectAgent("cursor", options(value)), /real directory/);
    assert.equal(existsSync(join(outside, "mcp.json")), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("remote connectors keep only an environment variable reference and require HTTPS off loopback", () => {
  const value = fixture();
  try {
    const remote = { ...options(value), transport: "http", url: "https://memory.example/mcp", tokenEnv: "VAULT_TOKEN" };
    connectAgent("codex", remote);
    connectAgent("opencode", remote);
    connectAgent("claude", remote);
    connectAgent("cursor", remote);
    assert.match(readFileSync(join(value.project, ".codex", "config.toml"), "utf8"), /bearer_token_env_var = "VAULT_TOKEN"/);
    assert.match(readFileSync(join(value.project, "opencode.json"), "utf8"), /\{env:VAULT_TOKEN\}/);
    const claudeHooks = readFileSync(join(value.project, ".claude", "settings.json"), "utf8");
    const cursorHooks = readFileSync(join(value.project, ".cursor", "hooks.json"), "utf8");
    for (const hooks of [claudeHooks, cursorHooks]) {
      assert.match(hooks, /--http-url/);
      assert.match(hooks, /https:\/\/memory\.example\//);
      assert.match(hooks, /--http-token-env/);
      assert.match(hooks, /VAULT_TOKEN/);
      assert.doesNotMatch(hooks, /Bearer /);
    }
    assert.throws(() => connectAgent("claude", { ...remote, url: "http://memory.example/mcp" }), /must use HTTPS/);
    const loopback = fixture();
    try {
      assert.doesNotThrow(() => connectAgent("claude", {
        ...remote,
        projectDir: loopback.project,
        home: loopback.home,
        url: "http://127.0.0.1:7331/mcp",
      }));
    } finally {
      rmSync(loopback.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("remote connectors reject reserved token environment names before any write", () => {
  for (const tokenEnv of ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD"]) {
    for (const client of SUPPORTED_AGENTS) {
      const value = fixture();
      try {
        assert.throws(() => connectAgent(client, {
          ...options(value), transport: "http", url: "https://memory.example/mcp", tokenEnv,
        }), /dedicated uppercase environment entry/);
        assert.equal(existsSync(clientPaths(value.project)[client]), false);
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    }
  }
});

test("agent detection reads PATH without executing discovered programs", () => {
  const value = fixture();
  try {
    const bin = join(value.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "must never run", { mode: 0o755 });
    const detected = detectAgents({ PATH: bin });
    assert.equal(detected.find((item) => item.client === "codex").installed, true);
    assert.equal(detected.find((item) => item.client === "claude").installed, false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("agent setup summary separates selected preview plans from applied connections", () => {
  const value = fixture();
  try {
    const bin = join(value.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "must never run", { mode: 0o755 });
    const detected = detectAgents({ PATH: bin });
    const summary = setupAgentSummary({
      requested: "detected",
      detectedAgents: detected,
      connections: [{ client: "opencode", applied: false }],
    });
    assert.deepEqual(summary, {
      requested: "detected",
      detected: ["opencode"],
      selected: ["opencode"],
      planned: ["opencode"],
      connected: [],
      supported_not_installed: ["codex", "claude", "cursor", "copilot"],
    });

    const applied = setupAgentSummary({
      requested: "detected",
      detectedAgents: detected,
      connections: [{ client: "opencode", applied: true }],
    });
    assert.deepEqual(applied.selected, ["opencode"]);
    assert.deepEqual(applied.planned, []);
    assert.deepEqual(applied.connected, ["opencode"]);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("MCP-only mode installs, verifies, and removes only transport assets", () => {
  const value = fixture();
  try {
    const originals = seedClientFiles(value.project);
    const before = contents(originals);
    const applied = connectAgents(SUPPORTED_AGENTS, { ...options(value), mcpOnly: true });
    assert.equal(applied.every((item) => item.recall_mode === "mcp-only"), true);
    assert.equal(applied.every((item) => item.capture_mode === "explicit-governed"), true);
    assert.equal(applied.every((item) => item.assets.length === 1 && item.assets[0].kind === "mcp"), true);
    assert.equal(applied.every((item) => item.verified), true);
    assert.equal(existsSync(join(value.project, "AGENTS.md")), false);
    assert.equal(existsSync(join(value.project, "CLAUDE.md")), false);
    assert.equal(existsSync(join(value.project, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(value.project, ".opencode", "plugins", "continuitydb.js")), false);
    assert.equal(existsSync(join(value.project, ".cursor", "hooks.json")), false);
    assert.equal(existsSync(join(value.project, ".cursor", "rules", "continuitydb.mdc")), false);
    assert.equal(existsSync(join(value.project, ".github", "copilot-instructions.md")), false);

    registerProject(value.home, { id: "service-a", root: value.project, source: "explicit" }, { apply: true });
    const status = connectionStatus(options(value));
    assert.equal(status.every((item) => item.connected && item.verified && !item.drifted), true);
    assert.equal(status.every((item) => item.recall_mode === "mcp-only"), true);
    assert.equal(status.every((item) => item.assets.length === 1 && item.assets[0].verified), true);

    const claudeMcpOnly = originals.claude;
    const healthyClaudeMcpOnly = readFileSync(claudeMcpOnly, "utf8");
    writeFileSync(claudeMcpOnly, `${healthyClaudeMcpOnly} `);
    const drifted = connectionStatus(options(value)).find((item) => item.client === "claude");
    assert.equal(drifted.connected, true);
    assert.equal(drifted.drifted, true);
    assert.equal(drifted.assets[0].changed, true);
    assert.throws(() => disconnectAgents(SUPPORTED_AGENTS, options(value)), /document ownership fingerprint mismatch/);
    assert.equal(readFileSync(claudeMcpOnly, "utf8"), `${healthyClaudeMcpOnly} `);
    writeFileSync(claudeMcpOnly, healthyClaudeMcpOnly);

    const disconnected = disconnectAgents(SUPPORTED_AGENTS, options(value));
    assert.equal(disconnected.every((item) => item.applied && item.verified), true);
    assert.deepEqual(contents(originals), before);
    const repeated = disconnectAgents(SUPPORTED_AGENTS, options(value));
    assert.equal(repeated.every((item) => !item.changed), true);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("connection status independently verifies every complete adapter asset without writing", () => {
  const value = fixture();
  try {
    connectAgents(SUPPORTED_AGENTS, options(value));
    registerProject(value.home, { id: "service-a", root: value.project, source: "explicit" }, { apply: true });
    const before = contents(clientPaths(value.project));
    const healthy = connectionStatus(options(value));
    assert.equal(healthy.every((item) => item.connected && item.verified && !item.drifted), true);
    assert.equal(healthy.every((item) => item.assets.length >= 2 && item.assets.every((asset) => asset.verified)), true);
    assert.deepEqual(contents(clientPaths(value.project)), before, "status must be read-only");

    const claudeMcp = join(value.project, ".mcp.json");
    const healthyClaudeMcp = readFileSync(claudeMcp, "utf8");
    rmSync(claudeMcp);
    const missingMcp = connectionStatus(options(value)).find((item) => item.client === "claude");
    assert.equal(missingMcp.connected, false);
    assert.equal(missingMcp.drifted, true);
    assert.equal(missingMcp.assets.find((asset) => asset.path === claudeMcp).missing, true);
    assert.equal(existsSync(claudeMcp), false, "status must not recreate a missing transport");
    writeFileSync(claudeMcp, healthyClaudeMcp, { mode: 0o600 });

    const claudePolicy = join(value.project, "CLAUDE.md");
    writeFileSync(claudePolicy, readFileSync(claudePolicy, "utf8")
      .replace("compact durable claim", "drifted durable claim"));
    const plugin = join(value.project, ".opencode", "plugins", "continuitydb.js");
    rmSync(plugin);
    const drifted = connectionStatus(options(value));
    const claude = drifted.find((item) => item.client === "claude");
    const opencode = drifted.find((item) => item.client === "opencode");
    assert.equal(claude.connected, true);
    assert.equal(claude.verified, false);
    assert.equal(claude.drifted, true);
    assert.equal(claude.assets.find((asset) => asset.path === claudePolicy).changed, true);
    assert.equal(opencode.connected, true);
    assert.equal(opencode.verified, false);
    assert.equal(opencode.drifted, true);
    assert.equal(opencode.assets.find((asset) => asset.path === plugin).missing, true);
    assert.equal(existsSync(plugin), false, "status must not repair missing assets");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Codex updates and disconnects only its current managed block", () => {
  const value = fixture();
  const path = join(value.project, ".codex", "config.toml");
  try {
    mkdirSync(join(value.project, ".codex"));
    const original = 'model = "gpt-5"\n';
    writeFileSync(path, original);
    connectAgent("codex", options(value));
    const connected = readFileSync(path, "utf8");
    const prefix = '# user edit after connect\n';
    const suffix = '\n[user_settings]\nkeep = "current"\n';
    writeFileSync(path, `${prefix}${connected}${suffix}`);
    const updated = connectAgent("codex", options(value));
    assert.equal(updated.changed, false);
    assert.equal(readFileSync(path, "utf8"), `${prefix}${connected}${suffix}`);
    disconnectAgent("codex", options(value));
    assert.equal(readFileSync(path, "utf8"), `${prefix}${original}${suffix}`);

    const legacy = [
      'theme = "user"',
      CODEX_START_FOR_TEST,
      "[mcp_servers.continuitydb]",
      'command = "legacy-continuitydb"',
      CODEX_END_FOR_TEST,
      "",
      "[current_user_edit]",
      "keep = true",
      "",
    ].join("\n");
    writeFileSync(path, legacy);
    connectAgent("codex", options(value));
    assert.doesNotMatch(readFileSync(path, "utf8"), /legacy-continuitydb/);
    disconnectAgent("codex", options(value));
    const disconnected = readFileSync(path, "utf8");
    assert.doesNotMatch(disconnected, /continuitydb|mcp_servers/i);
    assert.match(disconnected, /theme = "user"/);
    assert.match(disconnected, /\[current_user_edit\]\nkeep = true/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("Codex disconnect preserves valid TOML boundaries for every surrounding newline shape", () => {
  const cases = [
    {
      name: "no terminal LF with direct table",
      original: 'model = "gpt-5"',
      suffix: '[post_connect]\nkeep = "table"\n',
      expected: 'model = "gpt-5"\n[post_connect]\nkeep = "table"\n',
    },
    {
      name: "terminal LF with direct table",
      original: 'model = "gpt-5"\n',
      suffix: '[post_connect]\nkeep = "table"\n',
      expected: 'model = "gpt-5"\n[post_connect]\nkeep = "table"\n',
    },
    { name: "no terminal LF and empty suffix", original: 'model = "gpt-5"', suffix: "", expected: 'model = "gpt-5"' },
    { name: "terminal LF and empty suffix", original: 'model = "gpt-5"\n', suffix: "", expected: 'model = "gpt-5"\n' },
    {
      name: "direct comment and table",
      original: 'model = "gpt-5"',
      suffix: '# post-connect comment\n[post_connect]\nkeep = true\n',
      expected: 'model = "gpt-5"\n# post-connect comment\n[post_connect]\nkeep = true\n',
    },
    {
      name: "user-owned leading LF",
      original: 'model = "gpt-5"',
      suffix: '\n# preserved blank boundary\n[post_connect]\nkeep = true\n',
      expected: 'model = "gpt-5"\n# preserved blank boundary\n[post_connect]\nkeep = true\n',
    },
    {
      name: "direct key",
      original: 'model = "gpt-5"',
      suffix: 'post_connect_key = true\n',
      expected: 'model = "gpt-5"\npost_connect_key = true\n',
    },
    {
      name: "CRLF user document and suffix",
      original: 'model = "gpt-5"\r\n',
      suffix: '[post_connect]\r\nkeep = "crlf"\r\n',
      expected: 'model = "gpt-5"\r\n[post_connect]\r\nkeep = "crlf"\r\n',
    },
    {
      name: "empty original with direct table",
      original: "",
      suffix: '[post_connect]\nkeep = "only-user-content"\n',
      expected: '[post_connect]\nkeep = "only-user-content"\n',
    },
  ];
  for (const item of cases) {
    const value = fixture();
    const path = join(value.project, ".codex", "config.toml");
    try {
      mkdirSync(join(value.project, ".codex"));
      writeFileSync(path, item.original);
      connectAgent("codex", options(value));
      writeFileSync(path, `${readFileSync(path, "utf8")}${item.suffix}`);
      disconnectAgent("codex", options(value));
      assert.equal(readFileSync(path, "utf8"), item.expected, item.name);
      assert.doesNotThrow(() => parseToml(readFileSync(path, "utf8")), item.name);

      connectAgent("codex", options(value));
      connectAgent("codex", options(value));
      disconnectAgent("codex", options(value));
      disconnectAgent("codex", options(value));
      assert.equal(readFileSync(path, "utf8"), item.expected, `${item.name} repeated cycle`);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("Codex mode metadata is authoritative and mode transitions fail closed", () => {
  for (const initialMcpOnly of [false, true]) {
    const value = fixture();
    const path = join(value.project, ".codex", "config.toml");
    try {
      connectAgent("codex", { ...options(value), mcpOnly: initialMcpOnly });
      registerProject(value.home, { id: "service-a", root: value.project, source: "explicit" }, { apply: true });
      const healthy = readFileSync(path, "utf8");
      if (!initialMcpOnly) {
        writeFileSync(path, `# continuitydb adapter mode: mcp-only\n${healthy}`);
        const status = connectionStatus(options(value)).find((item) => item.client === "codex");
        assert.equal(status.recall_mode, "policy-led");
        assert.equal(status.verified, true);
        writeFileSync(path, healthy);
        assert.throws(
          () => disconnectAgent("codex", { ...options(value), mcpOnly: true }),
          /complete.*disconnect|mode/i,
        );
        assert.equal(readFileSync(path, "utf8"), healthy);
      }
      assert.throws(
        () => connectAgent("codex", { ...options(value), mcpOnly: !initialMcpOnly }),
        /disconnect.*switch|mode/i,
      );
      assert.equal(readFileSync(path, "utf8"), healthy);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("connection status rejects copied adapters at an unregistered project root without writing", () => {
  const value = fixture();
  const original = join(value.root, "one", "generic-repo");
  const copied = join(value.root, "two", "generic-repo");
  try {
    mkdirSync(join(original, ".git"), { recursive: true });
    connectAgent("codex", { ...options(value), projectDir: original, projectId: undefined });
    registerProject(value.home, { id: "generic-repo", root: original, source: "git" }, { apply: true });
    cpSync(original, copied, { recursive: true });
    const path = join(copied, ".codex", "config.toml");
    const before = readFileSync(path, "utf8");
    const status = connectionStatus({ ...options(value), projectDir: copied, projectId: undefined })
      .find((item) => item.client === "codex");
    assert.equal(status.connected, true);
    assert.equal(status.verified, false);
    assert.equal(status.drifted, true);
    assert.match(status.error, /registered.*root|not registered/i);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("JSON connectors reject hostile managed namespaces without changing user files", () => {
  const cases = [
    ["claude", ".mcp.json", "mcpServers"],
    ["cursor", join(".cursor", "mcp.json"), "mcpServers"],
    ["opencode", "opencode.json", "mcp"],
    ["copilot", join(".vscode", "mcp.json"), "servers"],
  ];
  for (const [client, relativePath, namespace] of cases) {
    for (const hostile of [[], "invalid", 7, null]) {
      const value = fixture();
      try {
        const path = join(value.project, relativePath);
        mkdirSync(join(path, ".."), { recursive: true });
        const original = `${JSON.stringify({ keep: true, [namespace]: hostile }, null, 2)}\n`;
        writeFileSync(path, original);
        assert.throws(() => connectAgent(client, options(value)), /namespace .* must be a JSON object/);
        assert.equal(readFileSync(path, "utf8"), original);
        assert.throws(() => disconnectAgent(client, options(value)), /namespace .* must be a JSON object/);
        assert.equal(readFileSync(path, "utf8"), original);
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    }
  }
});

test("Codex connector rejects malformed TOML and invalid managed markers without mutation", () => {
  const malformed = [
    "[broken\nvalue = true\n",
    `${CODEX_START_FOR_TEST}\n`,
    `${CODEX_END_FOR_TEST}\n`,
    `${CODEX_END_FOR_TEST}\n${CODEX_START_FOR_TEST}\n`,
    `${CODEX_START_FOR_TEST}\n${CODEX_START_FOR_TEST}\n${CODEX_END_FOR_TEST}\n`,
    `${CODEX_START_FOR_TEST}\n${CODEX_END_FOR_TEST}\n${CODEX_END_FOR_TEST}\n`,
  ];
  for (const original of malformed) {
    const value = fixture();
    try {
      const directory = join(value.project, ".codex");
      const path = join(directory, "config.toml");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, original);
      assert.throws(() => connectAgent("codex", options(value)), /invalid (TOML|ContinuityDB managed block)/);
      assert.equal(readFileSync(path, "utf8"), original);
      assert.throws(() => disconnectAgent("codex", options(value)), /invalid (TOML|ContinuityDB managed block)/);
      assert.equal(readFileSync(path, "utf8"), original);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("all-client connect preflights every configuration before changing any client file", () => {
  const hostileByClient = {
    codex: "[broken\nvalue = true\n",
    claude: "{ broken json\n",
    opencode: '{"mcp":"invalid"}\n',
    cursor: '{"mcpServers":[]}\n',
    copilot: '{"servers":7}\n',
  };
  for (const failedClient of SUPPORTED_AGENTS) {
    const value = fixture();
    try {
      const paths = seedClientFiles(value.project);
      writeFileSync(paths[failedClient], hostileByClient[failedClient]);
      const before = contents(paths);
      assert.throws(() => connectAgents(SUPPORTED_AGENTS, options(value)), /(invalid TOML|Unexpected token|Expected property|namespace .* must be a JSON object)/);
      assert.deepEqual(contents(paths), before, `batch mutated files before ${failedClient} validation failed`);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("all-client connect rolls back earlier client files when a later write fails", () => {
  const value = fixture();
  try {
    const claude = join(value.project, ".mcp.json");
    const original = '{"keep":"claude"}\n';
    writeFileSync(claude, original);
    mkdirSync(value.home, { recursive: true });
    // All client configs are valid during phase 1. The second commit fails only
    // when it tries to create its immutable backup beneath this non-directory.
    writeFileSync(join(value.home, "backups"), "blocks backup directory creation\n");
    assert.throws(() => connectAgents(SUPPORTED_AGENTS, options(value)), /(ENOTDIR|not a directory|backup parent must be a real directory)/i);
    assert.equal(readFileSync(claude, "utf8"), original);
    assert.equal(existsSync(join(value.project, ".codex", "config.toml")), false);
    assert.equal(existsSync(join(value.project, ".codex")), false);
    assert.equal(existsSync(join(value.project, "opencode.json")), false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("all-client rollback removes backup artifacts created before a later backup failure", () => {
  const value = fixture();
  try {
    const paths = seedClientFiles(value.project);
    const before = contents(paths);
    const backupRoot = join(value.home, "backups", "agent-config");
    mkdirSync(backupRoot, { recursive: true });
    const blocker = join(backupRoot, "opencode");
    writeFileSync(blocker, "pre-existing blocker\n");

    assert.throws(
      () => connectAgents(SUPPORTED_AGENTS, options(value)),
      /backup parent must be a real directory/,
    );

    assert.deepEqual(contents(paths), before);
    assert.equal(existsSync(join(backupRoot, "codex")), false);
    assert.equal(existsSync(join(backupRoot, "claude")), false);
    assert.equal(readFileSync(blocker, "utf8"), "pre-existing blocker\n");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rollback preserves a connector file changed by a concurrent writer", () => {
  const value = fixture();
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    const paths = seedClientFiles(value.project);
    const concurrent = 'model = "concurrent-writer"\n';
    const backupRoot = join(value.home, "backups", "agent-config");
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(join(backupRoot, "opencode"), "force a later commit failure\n");

    assert.throws(() => connectAgents(SUPPORTED_AGENTS, {
      ...options(value),
      _testAfterCommit: ({ committed }) => {
        if (committed === 1) writeFileSync(paths.codex, concurrent, { mode: 0o600 });
      },
    }), /rollback conflict: configuration changed concurrently/);

    assert.equal(readFileSync(paths.codex, "utf8"), concurrent);
    assert.equal(readFileSync(paths.claude, "utf8"), '{"keep":"claude"}\n');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("connector fails closed when a direct writer changes config before atomic replacement", () => {
  const value = fixture();
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    const paths = seedClientFiles(value.project);
    const concurrent = 'model = "direct-concurrent-writer"\n';
    assert.throws(() => connectAgent("codex", {
      ...options(value),
      _testBeforeReplace: ({ path }) => writeFileSync(path, concurrent, { mode: 0o600 }),
    }), /configuration changed before atomic replacement/);
    assert.equal(readFileSync(paths.codex, "utf8"), concurrent);
    assert.equal(existsSync(join(value.home, "backups", "agent-config", "codex")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(value.root, { recursive: true, force: true });
  }
});
