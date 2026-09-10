import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const document = YAML.parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(document.openapi, "3.1.0");
assert.equal(document.info.version, manifest.version);
for (const path of [
  "/healthz",
  "/readyz",
  "/v1/search",
  "/v1/context-packs",
  "/v1/memories/proposals",
  "/v1/memories/captures",
  "/v1/memories/{id}/feedback",
]) {
  assert.ok(document.paths[path], `OpenAPI path missing: ${path}`);
}
assert.ok(document.components.securitySchemes.bearerAuth);
process.stdout.write(`OpenAPI parsed: ${Object.keys(document.paths).length} paths\n`);
