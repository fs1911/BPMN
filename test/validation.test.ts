import { describe, expect, it } from "vitest";
import { validate, summarize } from "../src/core/validation";
import { createEdge, createNode, createParticipant, createProcess, emptyModel, resetIdCounter } from "../src/core/model";
import { buildSampleProcess } from "./helpers";

describe("BPMN validation", () => {
  it("accepts a well-formed process with only readability hints", () => {
    const m = buildSampleProcess();
    const issues = validate(m);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("flags a sequence flow that crosses pools", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P1" });
    createProcess(m, { id: "P2" });
    createParticipant(m, { id: "Pool1", processRef: "P1" });
    createParticipant(m, { id: "Pool2", processRef: "P2" });
    createNode(m, "task", { id: "a", parent: "P1", name: "Do A" });
    createNode(m, "task", { id: "b", parent: "P2", name: "Do B" });
    createEdge(m, "sequenceFlow", "a", "b");
    const issues = validate(m);
    expect(issues.some((i) => i.rule === "flow.same-pool")).toBe(true);
  });

  it("flags a message flow that stays within one pool", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P1" });
    createNode(m, "task", { id: "a", parent: "P1", name: "Do A" });
    createNode(m, "task", { id: "b", parent: "P1", name: "Do B" });
    createEdge(m, "messageFlow", "a", "b");
    const issues = validate(m);
    expect(issues.some((i) => i.rule === "messageflow.cross-pool")).toBe(true);
  });

  it("flags start events with incoming flow and end events with outgoing flow", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "startEvent", { id: "s", name: "Start" });
    createNode(m, "task", { id: "t", name: "Work" });
    createNode(m, "endEvent", { id: "e", name: "End" });
    createEdge(m, "sequenceFlow", "t", "s"); // illegal into start
    createEdge(m, "sequenceFlow", "e", "t"); // illegal out of end
    const issues = validate(m);
    expect(issues.some((i) => i.rule === "event.start-no-incoming")).toBe(true);
    expect(issues.some((i) => i.rule === "event.end-no-outgoing")).toBe(true);
  });

  it("warns about parallel gateways with conditional flows", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "parallelGateway", { id: "g" });
    createNode(m, "task", { id: "x", name: "X" });
    createEdge(m, "sequenceFlow", "g", "x", { condition: "${cond}" });
    const issues = validate(m);
    expect(issues.some((i) => i.rule === "gateway.parallel-condition")).toBe(true);
  });

  it("hints that exclusive gateways should be questions", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "exclusiveGateway", { id: "g", name: "Decision" });
    createNode(m, "task", { id: "a", name: "A" });
    createNode(m, "task", { id: "b", name: "B" });
    createEdge(m, "sequenceFlow", "g", "a");
    createEdge(m, "sequenceFlow", "g", "b");
    const issues = validate(m);
    expect(issues.some((i) => i.rule === "readability.gateway-question")).toBe(true);
  });

  it("summarizes issue counts", () => {
    const issues = validate(buildSampleProcess());
    const s = summarize(issues);
    expect(s.errors + s.warnings + s.infos).toBe(issues.length);
  });
});
