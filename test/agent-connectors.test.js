import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectAgent,
  connectAgents,
  connectionStatus,
  detectAgents,
  disconnectAgent,
  setupAgentSummary,
  SUPPORTED_AGENTS,
} from "../src/agent-connectors.js";

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
