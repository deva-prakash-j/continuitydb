import assert from "node:assert/strict";
import test from "node:test";
import { extractJavaSpring } from "../src/graph/java-spring-extractor.js";

const source = `package com.acme;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.beans.factory.annotation.Value;

interface OrderPort {}
class OrderService implements OrderPort {
  java.util.List<String> findAll() { return java.util.List.of(); }
}

@RestController
class OrderController {
  private final OrderService service;
  OrderController(OrderService service, @Value("\${orders.page-size}") int pageSize) {
    this.service = service;
  }
  @GetMapping("/orders")
  java.util.List<String> list() { return service.findAll(); }
  // class Pretend { void fake() { service.nope(); } }
  String literal = "service.nope()";
  void overloaded(String name) {}
  void overloaded(int count) {}
}`;

const input = {
  tenantId: "tenant-a", projectId: "orders", repoPath: "src/main/java/com/acme/OrderController.java",
  commit: "abcdef1", branch: "main", text: source,
};

function relations(result) {
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  return result.edges.map((edge) => `${edge.relation}:${nodes.get(edge.source_id).qualified_name}->${nodes.get(edge.target_id).qualified_name}`);
}

test("extracts deterministic Java and Spring graph facts", () => {
  const result = extractJavaSpring(input);
  assert.deepEqual(relations(result), [
    "calls:com.acme.OrderController.list->com.acme.OrderService.findAll",
    "contains:src/main/java/com/acme/OrderController.java->com.acme.OrderController",
    "contains:src/main/java/com/acme/OrderController.java->com.acme.OrderPort",
    "contains:src/main/java/com/acme/OrderController.java->com.acme.OrderService",
    "exposes:com.acme.OrderController.list->GET /orders",
    "implements:com.acme.OrderService->com.acme.OrderPort",
    "imports:src/main/java/com/acme/OrderController.java->org.springframework.beans.factory.annotation.Value",
    "imports:src/main/java/com/acme/OrderController.java->org.springframework.web.bind.annotation.GetMapping",
    "imports:src/main/java/com/acme/OrderController.java->org.springframework.web.bind.annotation.RestController",
    "reads-config:com.acme.OrderController->orders.page-size",
  ]);
  assert.ok(result.nodes.some((node) => node.qualified_name === "com.acme" && node.kind === "package"));
  assert.ok(result.nodes.some((node) => node.qualified_name === "com.acme.OrderController.list"));
  assert.ok(!result.nodes.some((node) => node.qualified_name.includes("Pretend") || node.qualified_name.includes("nope")));
  assert.ok(result.nodes.some((node) => node.qualified_name === "com.acme.OrderController.overloaded/1"));
  assert.deepEqual(result, extractJavaSpring(input));
});

test("handles fully-qualified annotations, secret configuration keys, and extends target kinds", () => {
  const result = extractJavaSpring({
    ...input,
    text: `package com.acme;
class Parent {}
class Child extends Parent {}
interface ParentPort {}
interface ChildPort extends ParentPort {}
class A {
  @org.springframework.beans.factory.annotation.Value("\${db.password}") String password;
  @org.springframework.beans.factory.annotation.Value("\${orders.page-size}") String pageSize;
  @org.springframework.web.bind.annotation.GetMapping("/orders") void list() {}
}`,
  });
  const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
  assert.ok(!result.nodes.some((node) => node.qualified_name.includes("db.password")));
  assert.ok(!result.edges.some((edge) => edge.relation === "reads-config" && edge.target.qualified_name.includes("db.password")));
  assert.ok(result.edges.some((edge) => edge.relation === "reads-config" && edge.target.qualified_name === "orders.page-size"));
  assert.ok(result.edges.some((edge) => edge.relation === "exposes" && edge.source.qualified_name === "com.acme.A.list" && edge.target.qualified_name === "GET /orders"));
  assert.ok(!result.nodes.some((node) => node.qualified_name === "com.acme.A.Value"));
  const classExtends = result.edges.find((edge) => edge.relation === "extends" && nodeById.get(edge.source_id).qualified_name === "com.acme.Child");
  const interfaceExtends = result.edges.find((edge) => edge.relation === "extends" && nodeById.get(edge.source_id).qualified_name === "com.acme.ChildPort");
  assert.equal(nodeById.get(classExtends.target_id).kind, "class");
  assert.equal(nodeById.get(interfaceExtends.target_id).kind, "interface");
});
