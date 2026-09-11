import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectAgent,
  connectionStatus,
  detectAgents,
  disconnectAgent,
  SUPPORTED_AGENTS,
} from "../src/agent-connectors.js";

const CODEX_START_FOR_TEST = "# >>> continuitydb managed configuration >>>";
const CODEX_END_FOR_TEST = "# <<< continuitydb managed configuration <<<";

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
    projects: ["service-a", "schema-a"],
  };
}

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
    assert.match(readFileSync(join(value.project, ".codex", "config.toml"), "utf8"), /bearer_token_env_var = "VAULT_TOKEN"/);
    assert.match(readFileSync(join(value.project, "opencode.json"), "utf8"), /\{env:VAULT_TOKEN\}/);
    assert.throws(() => connectAgent("claude", { ...remote, url: "http://memory.example/mcp" }), /must use HTTPS/);
    assert.doesNotThrow(() => connectAgent("claude", { ...remote, url: "http://127.0.0.1:7331/mcp" }));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
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
