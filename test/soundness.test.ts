import { describe, expect, it } from "vitest";
import { createEdge, createNode, emptyModel, type BpmnModel, type FlowElementType } from "../src/core";
import { analyzeSoundness } from "../src/core/simulation/soundness";
import { enumerateScenarios } from "../src/core/simulation/scenarios";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { CORPUS } from "./fixtures/processes";
import { randomProcess, setSeed } from "./fixtures/random-process";

/** Tiny DSL: nodes "id:type", flows "a>b" (optionally "a>b?cond" / "a>b!" for default). */
function build(nodes: string[], flows: string[]): BpmnModel {
  const m = emptyModel({ processId: "P" });
  for (const spec of nodes) {
    const [id, type, extra] = spec.split(":");
    createNode(m, type as FlowElementType, { id, name: id, ...(extra === "terminate" ? { eventDefinition: "terminate" } : {}) });
  }
  for (const f of flows) {
    const [a, rest] = f.split(">");
    const target = rest.replace(/[?!].*$/, "");
    createEdge(m, "sequenceFlow", a, target, { condition: rest.includes("?") ? rest.split("?")[1] : undefined, isDefault: rest.endsWith("!") });
  }
  return m;
}
const kinds = (m: BpmnModel) => analyzeSoundness(m).issues.map((i) => `${i.kind}@${i.elementIds[0]}`).sort();

describe("process simulation (soundness)", () => {
  it("accepts a clean XOR decision and a clean parallel block", () => {
    const xor = build(["s:startEvent", "g:exclusiveGateway", "a:task", "b:task", "j:exclusiveGateway", "e:endEvent"], ["s>g", "g>a?ja", "g>b?nein", "a>j", "b>j", "j>e"]);
    expect(kinds(xor)).toEqual([]);
    const and = build(["s:startEvent", "g:parallelGateway", "a:task", "b:task", "j:parallelGateway", "e:endEvent"], ["s>g", "g>a", "g>b", "a>j", "b>j", "j>e"]);
    expect(kinds(and)).toEqual([]);
  });

  it("finds the deadlock of an XOR split joined by an AND gateway, naming the decision", () => {
    const m = build(["s:startEvent", "g:exclusiveGateway", "a:task", "b:task", "j:parallelGateway", "e:endEvent"], ["s>g", "g>a?ja", "g>b?nein", "a>j", "b>j", "j>e"]);
    const r = analyzeSoundness(m);
    const dl = r.issues.find((i) => i.kind === "deadlock")!;
    expect(dl.elementIds).toEqual(["j", "g"]);
    expect(dl.message).toContain("„g“");
    expect(dl.trace[0]).toBe("„s“");
    expect(kinds(m)).toContain("dead@e");
  });

  it("finds double execution after an AND split merged by XOR or directly into a task", () => {
    const viaXor = build(["s:startEvent", "g:parallelGateway", "a:task", "b:task", "j:exclusiveGateway", "c:task", "e:endEvent"], ["s>g", "g>a", "g>b", "a>j", "b>j", "j>c", "c>e"]);
    expect(kinds(viaXor)).toContain("unsafe@j");
    const direct = build(["s:startEvent", "g:parallelGateway", "a:task", "b:task", "c:task", "e:endEvent"], ["s>g", "g>a", "g>b", "a>c", "b>c", "c>e"]);
    expect(kinds(direct)).toContain("unsafe@c");
  });

  it("finds a loop without exit", () => {
    const m = build(["s:startEvent", "a:task", "g:exclusiveGateway", "b:task", "e:endEvent"], ["s>a", "a>g", "g>b?x", "g>a?y", "b>a"]);
    const r = analyzeSoundness(m);
    expect(r.issues.map((i) => i.kind)).toContain("no-way-out");
  });

  it("handles OR split/join, defaults, terminate ends and interrupting boundary events", () => {
    const or = build(["s:startEvent", "g:inclusiveGateway", "a:task", "b:task", "j:inclusiveGateway", "e:endEvent"], ["s>g", "g>a?x", "g>b!", "a>j", "b>j", "j>e"]);
    expect(kinds(or)).toEqual([]);
    const term = build(["s:startEvent", "g:parallelGateway", "a:task", "b:task", "t:endEvent:terminate", "e:endEvent"], ["s>g", "g>a", "g>b", "a>t", "b>e"]);
    expect(kinds(term)).toEqual([]);
    const m = build(["s:startEvent", "a:task", "e:endEvent", "x:endEvent"], ["s>a", "a>e"]);
    createNode(m, "boundaryEvent", { id: "b", attachedToRef: "a", eventDefinition: "timer" });
    createEdge(m, "sequenceFlow", "b", "x");
    expect(kinds(m)).toEqual([]);
  });

  it("raises no false alarm on the sound reference processes and catches the real error in one of them", () => {
    for (const [name, ir] of Object.entries(CORPUS)) {
      const { model } = mapGraphToModel(sanitizeGraphIR(ir).ir);
      const r = analyzeSoundness(model);
      expect(r.truncated).toBe(false);
      if (name !== "reklamation") expect({ name, issues: r.issues.map((i) => i.message) }).toEqual({ name, issues: [] });
    }
    // An earlier AI result: "Angebot abgelehnt" ends inside a parallel section, so the AND-join never completes.
    const { model } = mapGraphToModel(sanitizeGraphIR(CORPUS.reklamation).ir);
    const [dl] = analyzeSoundness(model).issues;
    expect(dl.kind).toBe("deadlock");
    expect(dl.message).toContain("„Angebot abgelehnt“");
    expect(dl.message).toContain("„Angebot angenommen?“");
  });

  it("stays fast and consistent on 60 random processes (which do contain real errors)", () => {
    setSeed(7);
    let worst = 0;
    let withIssues = 0;
    for (let i = 0; i < 60; i++) {
      const { model } = mapGraphToModel(sanitizeGraphIR(randomProcess(3 + ((i * 7919) % 38), i % 5 === 4)).ir);
      const t = performance.now();
      const r = analyzeSoundness(model);
      worst = Math.max(worst, performance.now() - t);
      if (r.issues.length) withIssues++;
      for (const x of r.issues) for (const id of x.elementIds) expect(model.nodes[id] ?? model.edges[id]).toBeDefined();
    }
    expect(worst).toBeLessThan(500);
    expect(withIssues).toBeGreaterThan(0);
  });
});

describe("automatic run-through (all paths)", () => {
  it("plays every way out of every decision and judges each path", () => {
    const m = build(
      ["s:startEvent", "g:exclusiveGateway", "a:task", "b:task", "j:exclusiveGateway", "e:endEvent"],
      ["s>g", "g>a?ja", "g>b?nein", "a>j", "b>j", "j>e"],
    );
    const { scenarios, truncated } = enumerateScenarios(m);
    expect(truncated).toBe(false);
    expect(scenarios.map((s) => s.choices.map((c) => c.label).join())).toEqual(["„g“ = ja", "„g“ = nein"]);
    expect(scenarios.every((s) => s.outcome === "ok")).toBe(true);
    // first path: s → g → a → j → e, one element per round
    expect(scenarios[0].rounds.map((r) => r.map((f) => f.node).join("+"))).toEqual(["s", "g", "a", "j", "e"]);
  });

  it("advances parallel branches together and marks deadlocks and double runs per path", () => {
    const and = build(["s:startEvent", "g:parallelGateway", "a:task", "b:task", "j:parallelGateway", "e:endEvent"], ["s>g", "g>a", "g>b", "a>j", "b>j", "j>e"]);
    const [only] = enumerateScenarios(and).scenarios;
    expect(only.rounds.map((r) => r.map((f) => f.node).sort().join("+"))).toEqual(["s", "g", "a+b", "j", "e"]);
    const dl = build(["s:startEvent", "g:exclusiveGateway", "a:task", "b:task", "j:parallelGateway", "e:endEvent"], ["s>g", "g>a?ja", "g>b?nein", "a>j", "b>j", "j>e"]);
    expect(enumerateScenarios(dl).scenarios.map((s) => `${s.outcome}@${s.problemAt.join()}`)).toEqual(["deadlock@j", "deadlock@j"]);
    const un = build(["s:startEvent", "g:parallelGateway", "a:task", "b:task", "j:exclusiveGateway", "e:endEvent"], ["s>g", "g>a", "g>b", "a>j", "b>j", "j>e"]);
    expect(enumerateScenarios(un).scenarios[0].outcome).toBe("unsafe");
  });

  it("takes a rework loop once and then leaves it", () => {
    const m = build(["s:startEvent", "a:task", "g:exclusiveGateway", "e:endEvent"], ["s>a", "a>g", "g>a?nochmal", "g>e?fertig"]);
    const labels = enumerateScenarios(m).scenarios.map((s) => `${s.outcome}:${s.choices.map((c) => c.label).join(" → ")}`);
    expect(labels).toEqual(["ok:„g“ = nochmal → „g“ = fertig"]);
  });

  it("finds the same problem as the exhaustive check on the complaint process", () => {
    const { model } = mapGraphToModel(sanitizeGraphIR(CORPUS.reklamation).ir);
    const r = enumerateScenarios(model);
    const bad = r.scenarios.filter((s) => s.outcome !== "ok");
    expect(bad.length).toBe(1);
    expect(bad[0].choices.map((c) => c.label).join(" → ")).toContain("„Angebot angenommen?“ = nein");
    expect(r.scenarios.length).toBe(3);
  });

  it("covers the tender process with few paths, quickly", () => {
    const { model } = mapGraphToModel(sanitizeGraphIR(CORPUS.ausschreibung).ir);
    const t = performance.now();
    const r = enumerateScenarios(model);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.truncated).toBe(false);
    expect(r.scenarios.length).toBeGreaterThan(3);
    expect(r.scenarios.length).toBeLessThan(16);
    // every way out of every decision appears in some path
    const taken = new Set(r.scenarios.flatMap((s) => s.choices.map((c) => c.label)));
    for (const g of Object.values(model.nodes).filter((n) => n.type === "exclusiveGateway")) {
      const outFlows = Object.values(model.edges).filter((e) => e.type === "sequenceFlow" && e.source === g.id);
      if (outFlows.length < 2) continue;
      expect(outFlows.every((e) => [...taken].some((l) => l.endsWith(`= ${e.name?.trim() || e.condition?.trim() || ""}`) || l.includes(model.nodes[e.target].name ?? "§")))).toBe(true);
    }
    expect(r.scenarios.every((s) => s.outcome === "ok" || s.outcome === "loop")).toBe(true);
  });
});
