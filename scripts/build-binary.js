#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EMBEDDED_RUNTIME_SPEC } from "../src/binary-runtime.js";
import { VERSION } from "../src/version.js";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  throw new Error("binary builds require Node.js 25.5 or newer; produced binaries include their own runtime");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(process.env.CONTINUITYDB_BINARY_OUT || join(root, "dist"));
const extension = platform() === "win32" ? ".exe" : "";
const output = join(outputDirectory, process.env.CONTINUITYDB_BINARY_NAME || `continuitydb-${platform()}-${arch()}${extension}`);
// Node SEA embeds paths from its configuration. Use a private build directory
// for concurrency safety, but write only stable relative paths to the SEA
// config so checkout paths and TMPDIR do not affect the executable bytes.
const deterministicRoot = mkdtempSync(join(tmpdir(), `continuitydb-sea-v${VERSION}-${platform()}-${arch()}-`));
const workDirectory = join(deterministicRoot, "work");
const stagedOutput = join(workDirectory, `continuitydb${extension}`);
const bundle = join(workDirectory, "continuitydb.mjs");
const configuration = join(workDirectory, "sea-config.json");
const runtimeAsset = join(root, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm");
const stagedRuntimeAsset = join(workDirectory, "onnxruntime.wasm");

const runtimeBytes = readFileSync(runtimeAsset);
const runtimeSpecification = EMBEDDED_RUNTIME_SPEC.assets.find((item) => item.asset === "onnxruntime.wasm");
if (!runtimeSpecification || runtimeBytes.byteLength !== runtimeSpecification.bytes
  || createHash("sha256").update(runtimeBytes).digest("hex") !== runtimeSpecification.sha256) {
  throw new Error("onnxruntime-web WASM asset does not match the pinned standalone-binary specification");
}

mkdirSync(workDirectory, { recursive: true, mode: 0o700 });
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
copyFileSync(runtimeAsset, stagedRuntimeAsset);

try {
  await build({
    entryPoints: [join(root, "src", "cli.js")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node25.5",
    format: "esm",
    sourcemap: false,
    minify: true,
    legalComments: "none",
    define: { __CONTINUITYDB_BUNDLE__: "true" },
  });

  writeFileSync(configuration, `${JSON.stringify({
    main: "continuitydb.mjs",
    mainFormat: "module",
    executable: process.execPath,
    output: `continuitydb${extension}`,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgv: ["--no-warnings"],
    execArgvExtension: "none",
    assets: {
      "onnxruntime.wasm": "onnxruntime.wasm",
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const result = spawnSync(process.execPath, ["--build-sea", "sea-config.json"], {
    cwd: workDirectory,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Node SEA build failed");
  copyFileSync(stagedOutput, output);
  if (platform() !== "win32") chmodSync(output, 0o755);
} finally {
  rmSync(deterministicRoot, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({
  built: true,
  output,
  name: basename(output),
  runtime: process.version,
  platform: platform(),
  arch: arch(),
}, null, 2)}\n`);
