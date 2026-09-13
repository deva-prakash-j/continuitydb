#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extension = process.platform === "win32" ? ".exe" : "";
const binary = resolve(process.env.CONTINUITYDB_BINARY_PATH || process.argv[2]
  || join("dist", `continuitydb-${process.platform}-${process.arch}${extension}`));
const nativeOpenCode = {
  "linux-x64": join("node_modules", "opencode-linux-x64", "bin", "opencode"),
  "darwin-arm64": join("node_modules", "opencode-darwin-arm64", "bin", "opencode"),
  "win32-x64": join("node_modules", "opencode-windows-x64", "bin", "opencode.exe"),
}[`${process.platform}-${process.arch}`];
assert.ok(nativeOpenCode || process.env.OPENCODE_BINARY_PATH,
  `unsupported OpenCode native smoke target: ${process.platform}-${process.arch}`);
const opencode = resolve(process.env.OPENCODE_BINARY_PATH || nativeOpenCode);
if (process.platform !== "win32") {
  chmodSync(binary, 0o755);
  chmodSync(opencode, 0o755);
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "continuitydb-opencode-native-")));
const workspaceOne = join(root, "workspace-one");
const workspaceTwo = join(root, "workspace-two");
const repoOne = join(workspaceOne, "service");
const repoTwo = join(workspaceTwo, "service");
const configRoot = join(root, "config");
const configDir = join(configRoot, "opencode");
const home = join(root, "vault");

function result(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 45_000,
    windowsHide: true,
    ...options,
  });
}

function succeed(command, args, options = {}) {
  const completed = result(command, args, options);
  assert.equal(completed.status, 0, `${command} ${args.join(" ")} failed: ${JSON.stringify({
    status: completed.status,
    signal: completed.signal,
    error: completed.error?.message || null,
    stdout: completed.stdout,
    stderr: completed.stderr,
  })}`);
  return completed.stdout.trim() ? JSON.parse(completed.stdout) : null;
}

function opencodeEnvironment() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    HOME: root,
    USERPROFILE: root,
  };
}

function openRepository(repository) {
  return succeed(opencode, ["debug", "config"], {
    cwd: repository,
    env: opencodeEnvironment(),
  });
}

function runAsync(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 60_000);
    function append(name, chunk) {
      if (name === "stdout") stdout += String(chunk);
      else stderr += String(chunk);
      if (stdout.length + stderr.length > 4 * 1024 * 1024) child.kill();
    }
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

function sendCompletion(response, delta, finishReason) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({
    id: "continuitydb-open-code-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model: "memory-smoke",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function startToolCallingProvider(marker) {
  let toolRound = 0;
  const requests = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "memory-smoke", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 2 * 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      const value = JSON.parse(body);
      const tools = (value.tools || []).map((entry) => entry?.function?.name).filter(Boolean);
      requests.push({ tools, messages: value.messages || [] });
      if (tools.length === 0) {
        sendCompletion(response, { role: "assistant", content: "ContinuityDB memory smoke" }, "stop");
        return;
      }
      if (!tools.includes("continuitydb_remember") || !tools.includes("continuitydb_memory_search")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "ContinuityDB tools were not registered by OpenCode" } }));
        return;
      }
      if (toolRound === 0) {
        toolRound += 1;
        sendCompletion(response, {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "remember-call",
            type: "function",
            function: {
              name: "continuitydb_remember",
              arguments: JSON.stringify({ body: `${marker} is active.`, kind: "working", sensitivity: "private" }),
            },
          }],
        }, "tool_calls");
        return;
      }
      if (toolRound === 1) {
        toolRound += 1;
        sendCompletion(response, {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "search-call",
            type: "function",
            function: { name: "continuitydb_memory_search", arguments: JSON.stringify({ query: marker }) },
          }],
        }, "tool_calls");
        return;
      }
      sendCompletion(response, { role: "assistant", content: "ContinuityDB tool smoke complete." }, "stop");
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

function toolMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => typeof part === "string" ? part : (part?.text || "")).join("");
}

async function invokeToolsThroughOpenCode(repository, projectId, marker) {
  const provider = await startToolCallingProvider(marker);
  try {
    writeFileSync(join(configDir, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        "continuity-smoke": {
          npm: "@ai-sdk/openai-compatible@3.0.48",
          name: "ContinuityDB local smoke provider",
          options: { baseURL: provider.baseURL, apiKey: "local-smoke-placeholder" },
          models: { "memory-smoke": { name: "ContinuityDB memory smoke" } },
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    const completed = await runAsync(opencode, [
      "run", "--print-logs", "--log-level", "DEBUG",
      "--dir", repository,
      "--model", "continuity-smoke/memory-smoke", "--format", "json",
      "Use continuitydb_remember once, then continuitydb_memory_search once.",
    ], { cwd: repository, env: opencodeEnvironment() });
    assert.equal(completed.status, 0, `real OpenCode tool run failed: ${JSON.stringify(completed)}`);
    const toolMessages = provider.requests.flatMap((request) => request.messages)
      .filter((message) => message.role === "tool");
    const remembered = toolMessages.find((message) => message.tool_call_id === "remember-call");
    const searched = toolMessages.find((message) => message.tool_call_id === "search-call");
    assert.ok(remembered, "OpenCode did not return the installed remember tool result to the model");
    assert.ok(searched, "OpenCode did not return the installed search tool result to the model");
    assert.match(toolMessageText(remembered), new RegExp(projectId), completed.stderr);
    assert.match(toolMessageText(searched), new RegExp(projectId), completed.stderr);
    assert.match(toolMessageText(searched), new RegExp(marker), completed.stderr);
  } finally {
    await provider.close();
  }
}

try {
  for (const repository of [repoOne, repoTwo]) {
    mkdirSync(repository, { recursive: true });
    succeed("git", ["init", "-q"], { cwd: repository });
  }

  const installed = succeed(binary, [
    "opencode", "install",
    "--workspace-root", workspaceOne,
    "--workspace-root", workspaceTwo,
    "--opencode-config-dir", configDir,
    "--home", home,
    "--apply",
  ]);
  assert.equal(installed.verified, true);
  assert.deepEqual(installed.workspace_roots, [workspaceOne, workspaceTwo]);

  for (const repository of [repoOne, repoTwo]) {
    const config = openRepository(repository);
    assert.equal(config.permission?.["continuitydb_*"], "allow");
    assert.equal(config.plugin_origins?.some((origin) => origin.scope === "global"
      && origin.spec.includes("continuitydb.js")), true);
  }

  const projects = succeed(binary, ["projects", "list", "--home", home]).projects;
  assert.equal(projects.length, 2);
  assert.equal(projects[0].id, "service");
  assert.match(projects[1].id, /^service-[a-f0-9]{12}$/);
  assert.equal(projects.some((project) => project.id === "default"), false);

  for (const [index, project] of projects.entries()) {
    const marker = `OpenCodeNativeMemory${index + 1}`;
    await invokeToolsThroughOpenCode(project.root, project.id, marker);
  }

  const removed = succeed(binary, [
    "opencode", "uninstall", "--opencode-config-dir", configDir, "--apply",
  ]);
  assert.equal(removed.verified, true);
  assert.equal(succeed(binary, ["projects", "list", "--home", home]).projects.length, 2,
    "uninstall must retain project memory and registry data");
  assert.equal(readFileSync(join(home, "config.json"), "utf8").includes('"default"'), false);

  process.stdout.write(`${JSON.stringify({
    passed: true,
    binary,
    opencode,
    projects: projects.map(({ id, root: projectRoot }) => ({ id, root: projectRoot })),
    checks: [
      "global-install", "real-opencode-plugin-load", "automatic-project-registration",
      "collision-safe-project-ids", "plan-tool-permission", "installed-plugin-handler-capture-search",
      "memory-preserving-uninstall",
    ],
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
