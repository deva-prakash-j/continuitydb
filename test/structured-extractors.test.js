import assert from "node:assert/strict";
import test from "node:test";
import { extractStructuredGraph } from "../src/graph/structured-extractors.js";

const scope = { tenantId: "tenant-a", projectId: "orders", commit: "abcdef1", branch: "main" };
function extract(repoPath, text) { return extractStructuredGraph({ ...scope, repoPath, text }); }
function edgesFor(repoPath, text) { return extract(repoPath, text).edges; }
function nodesFor(repoPath, text) { return extract(repoPath, text).nodes; }

test("extracts dependency, configuration, and documentation facts without values", () => {
  assert.ok(edgesFor("pom.xml", `<project><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-web</artifactId><version>6.1.0</version></dependency></dependencies></project>`)
    .some((edge) => edge.relation === "depends-on" && edge.target.qualified_name === "org.springframework:spring-web"));
  assert.ok(edgesFor("build.gradle.kts", `implementation("org.springframework:spring-web:6.1.0")\napi('com.acme:core:1.0')`)
    .some((edge) => edge.target.qualified_name === "org.springframework:spring-web"));
  assert.ok(edgesFor("application.yml", "server:\n  port: 8080\napp:\n  name: orders\npassword: should-not-leak\n")
    .some((edge) => edge.relation === "declares" && edge.target.qualified_name === "server.port"));
  assert.ok(nodesFor("application.json", '{"server":{"port":8080},"token":"do-not-leak"}')
    .some((node) => node.qualified_name === "/server/port"));
  assert.ok(nodesFor("ADR-004.md", "# Context\nA safe summary.\n## Decision\nUse HTTP.\n")
    .some((node) => node.kind === "document-section" && node.qualified_name === "ADR-004#Decision"));
});

test("handles duplicate keys and malformed input safely and deterministically", () => {
  const duplicate = extract("application.yml", "server:\n  port: 8080\n  port: 9090\nsecret:\n  value: do-not-leak\n");
  assert.equal(duplicate.nodes.filter((node) => node.qualified_name === "server.port").length, 1);
  assert.ok(!JSON.stringify(duplicate).includes("do-not-leak"));
  assert.ok(!JSON.stringify(extract("ADR-005.md", "# password: do-not-leak\n")).includes("do-not-leak"));
  const malformed = extract("application.json", '{"server":');
  assert.deepEqual(malformed.nodes, []);
  assert.equal(malformed.diagnostics.errors, 1);
  assert.deepEqual(duplicate, extract("application.yml", "server:\n  port: 8080\n  port: 9090\nsecret:\n  value: do-not-leak\n"));
});
