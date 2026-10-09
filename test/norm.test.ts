import { describe, expect, it } from "vitest";
import { SSE_HEADERS, claudeSse } from "../scripts/lib/claude-sse.mjs";
import { createEdge, createNode, emptyModel, measureLayout, type BpmnModel, type FlowElementType } from "../src/core";
import { validate } from "../src/core/validation";
import { simulationIssues } from "../src/core/simulation";
import { analyzeSoundness } from "../src/core/simulation/soundness";
import { enumerateScenarios } from "../src/core/simulation/scenarios";
import { generateViaLlm, mapGraphToModel, modelToGraphIR, normViolations, sanitizeGraphIR, type GraphIR } from "../src/core/ai";
import { exportBpmn, importBpmn } from "../src/core/xml";
import { BAUETAPPE } from "./fixtures/processes";

/**
 * Rules of ISO/IEC 19510 (BPMN 2.0.1) as FlowCraft applies them: execution
 * semantics of the simulation (clause 13), the checks of clause 10 and the
 * AI format for boundary events. Each case names its clause.
 */

/** nodes "id:type[:trigger]", flows "a>b", "a>b?cond", "a>b!" (default) */
function build(nodes: string[], flows: string[]): BpmnModel {
  const m = emptyModel({ processId: "P" });
  for (const spec of nodes) {
    const [id, type, def] = spec.split(":");
    createNode(m, type as FlowElementType, { id, name: id, ...(def ? { eventDefinition: def as any } : {}) });
  }
  for (const f of flows) {
    const [a, rest] = f.split(">");
    const target = rest.replace(/[?!].*$/, "");
    createEdge(m, "sequenceFlow", a, target, { condition: rest.includes("?") ? rest.split("?")[1] : undefined, isDefault: rest.endsWith("!") });
  }
  return m;
}
const rules = (m: BpmnModel) => validate(m).map((i) => i.rule);
const flowKinds = (m: BpmnModel) => analyzeSoundness(m).issues.map((i) => `${i.kind}@${i.elementIds[0]}`);

describe("execution semantics (clause 13)", () => {
  it("OR join waits only for tokens that cannot reach a marked input (table 13.3)", () => {
    // OR block inside one branch of a parallel block that loops back in front of the AND split:
    // the other branch can reach the OR join's empty input only through the loop — which also
    // reaches its marked input, so the join must fire (this was reported as a deadlock).
    const m = build(
      ["s:startEvent", "m0:exclusiveGateway", "p1:parallelGateway", "a:task", "o1:inclusiveGateway", "b:task", "c:task", "o2:inclusiveGateway", "p2:parallelGateway", "x:exclusiveGateway", "r:task", "e:endEvent"],
      ["s>m0", "m0>p1", "p1>a", "p1>o1", "o1>b?b", "o1>c?c", "o1>o2!", "b>o2", "c>o2", "a>p2", "o2>p2", "p2>x", "x>r?nein", "x>e?ja", "r>m0"],
    );
    expect(flowKinds(m)).toEqual([]);
    expect(enumerateScenarios(m).scenarios.every((s) => s.outcome === "ok" || s.outcome === "loop")).toBe(true);
  });

  it("OR join still waits for a branch that is genuinely still running", () => {
    const m = build(
      ["s:startEvent", "o1:inclusiveGateway", "a:task", "a2:task", "b:task", "o2:inclusiveGateway", "e:endEvent"],
      ["s>o1", "o1>a?x", "o1>b?y", "a>a2", "a2>o2", "b>o2", "o2>e"],
    );
    // one run where both branches are taken: the join must not fire twice
    expect(flowKinds(m)).toEqual([]);
  });

  it("activity: flows without condition always run, conditional ones by choice (13.3.1)", () => {
    // t → u (always) and t → v (only if its condition holds): u must never be skipped
    const m = build(["s:startEvent", "t:task", "u:task", "v:task", "j:parallelGateway", "e:endEvent", "e2:endEvent"], ["s>t", "t>u", "t>v?bedingt", "u>e", "v>e2"]);
    const paths = enumerateScenarios(m).scenarios;
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.rounds.flat().some((f) => f.node === "u")).toBe(true);
  });

  it("complex gateway synchronises like an OR join instead of waiting for all inputs (10.6.5)", () => {
    const m = build(
      ["s:startEvent", "o1:inclusiveGateway", "a:task", "b:task", "c:complexGateway", "e:endEvent"],
      ["s>o1", "o1>a?x", "o1>b?y", "a>c", "b>c", "c>e"],
    );
    expect(flowKinds(m)).toEqual([]);
  });

  it("the construction stage is sound; unnamed gateways are named by their place", () => {
    const { model } = mapGraphToModel(sanitizeGraphIR(BAUETAPPE).ir);
    const r = analyzeSoundness(model);
    expect(r.truncated).toBe(false);
    expect(r.issues).toEqual([]);
    const paths = enumerateScenarios(model);
    expect(paths.scenarios.length).toBeLessThanOrEqual(6);
    expect(paths.scenarios.every((s) => s.outcome === "ok")).toBe(true);
    // the exception path is played: "Sicherheitsmangel gemeldet" occurs in some path
    expect(paths.scenarios.some((s) => s.choices.some((c) => c.label.includes("Sicherheitsmangel gemeldet“ tritt ein")))).toBe(true);
    expect(paths.scenarios.flatMap((s) => s.choices.map((c) => c.label)).some((l) => l.includes("„Bauarbeiten ausführen“ regulär beendet"))).toBe(true);
  });

  it("names two stuck unnamed gateways differently", () => {
    // AND split joined by an OR gateway and an AND gateway after XOR decisions → stuck at both
    const m = build(
      ["s:startEvent", "x:exclusiveGateway", "a:task", "b:task", "j:parallelGateway", "Weiter:task", "e:endEvent"],
      ["s>x", "x>a?ja", "x>b?nein", "a>j", "b>j", "j>Weiter", "Weiter>e"],
    );
    m.nodes.j.name = undefined;
    const msg = analyzeSoundness(m).issues.find((i) => i.kind === "deadlock")!.message;
    expect(msg).toContain("beim parallelen Gateway vor „Weiter“");
  });
});

describe("checks of clause 10", () => {
  it("link events: one target per jump, never both source and target (10.5.4)", () => {
    const m = build(["s:startEvent", "l1:intermediateThrowEvent:link", "l2:intermediateCatchEvent:link", "l3:intermediateCatchEvent:link", "e:endEvent"], ["s>l1", "l2>e", "l3>e"]);
    for (const id of ["l1", "l2", "l3"]) m.nodes[id].name = "A";
    expect(rules(m)).toContain("event.link-ambiguous");
    m.nodes.l3.name = "B";
    expect(rules(m)).not.toContain("event.link-ambiguous");
    m.nodes.l2.name = "C";
    expect(rules(m)).toContain("event.link-target");
  });

  it("boundary events: allowed trigger, error always interrupting, no incoming, an outgoing flow (10.5.4)", () => {
    const m = build(["s:startEvent", "t:task", "x:task", "e:endEvent", "e2:endEvent"], ["s>t", "t>e", "x>e2"]);
    createNode(m, "boundaryEvent", { id: "b", attachedToRef: "t", eventDefinition: "error", cancelActivity: false });
    expect(rules(m)).toEqual(expect.arrayContaining(["event.boundary-noninterrupting", "event.boundary-outgoing"]));
    m.nodes.b.eventDefinition = undefined;
    expect(rules(m)).toContain("event.boundary-trigger");
    m.nodes.b.eventDefinition = "timer";
    createEdge(m, "sequenceFlow", "b", "x");
    expect(rules(m).filter((r) => r.startsWith("event.boundary"))).toEqual([]);
    createEdge(m, "sequenceFlow", "s", "b");
    expect(rules(m)).toContain("event.boundary-incoming");
  });

  it("intermediate events: no error in the flow, one way in and out (10.5.4)", () => {
    const m = build(["s:startEvent", "i:intermediateCatchEvent:error", "e:endEvent"], ["s>i", "i>e"]);
    expect(rules(m)).toContain("event.intermediate-trigger");
    const dangling = build(["s:startEvent", "i:intermediateCatchEvent:timer", "e:endEvent"], ["s>e"]);
    expect(rules(dangling)).toEqual(expect.arrayContaining(["event.intermediate-incoming", "event.intermediate-outgoing"]));
  });

  it("start without end and end without start (10.5.2 / 10.5.3)", () => {
    expect(rules(build(["s:startEvent", "t:task"], ["s>t"]))).toContain("event.end-missing");
    expect(rules(build(["t:task", "e:endEvent"], ["t>e"]))).toContain("event.start-missing");
  });

  it("event-based gateway configuration (10.6.6)", () => {
    const m = build(
      ["s:startEvent", "g:eventBasedGateway", "m1:intermediateCatchEvent:message", "r:receiveTask", "t:task", "e:endEvent"],
      ["s>g", "g>m1?x", "g>r", "g>t", "m1>e", "r>e", "t>e", "s>r"],
    );
    expect(rules(m)).toEqual(
      expect.arrayContaining(["gateway.event-based-condition", "gateway.event-based-targets", "gateway.event-based-target-incoming", "gateway.event-based-mixed"]),
    );
    expect(validate(m).filter((i) => i.rule.startsWith("gateway.event-based")).every((i) => i.norm === "10.6.6" && i.severity === "error")).toBe(true);
  });

  it("style is marked as style, never as an error of the standard", () => {
    const { model } = mapGraphToModel(sanitizeGraphIR(BAUETAPPE).ir);
    const issues = validate(model);
    const restart = issues.filter((i) => i.rule === "style.loop-restarts-parallel");
    // "Nachbesserung koordinieren" restarts the three preparation branches, "Mängel beheben" both checks
    expect(restart.map((i) => i.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("„Nachbesserung koordinieren“ startet alle 3 parallelen Zweige neu"), expect.stringContaining("„Mängel beheben“")]),
    );
    expect(restart.every((i) => i.style && !i.norm && i.severity === "info")).toBe(true);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(normViolations(model)).toEqual([]);
  });

  it("simulation errors carry clause 14.1", () => {
    const m = build(["s:startEvent", "x:exclusiveGateway", "a:task", "b:task", "j:parallelGateway", "e:endEvent"], ["s>x", "x>a?ja", "x>b?nein", "a>j", "b>j", "j>e"]);
    expect(simulationIssues(m).find((i) => i.rule === "simulation.deadlock")?.norm).toBe("14.1");
  });
});

describe("boundary events in the AI format", () => {
  const base = (): GraphIR => JSON.parse(JSON.stringify(BAUETAPPE));

  it("maps the construction stage's boundary event onto its activity and lays the exception path out behind it", () => {
    const { model, review } = mapGraphToModel(sanitizeGraphIR(base()).ir);
    // the exception path counts as reachable (it starts at the activity)
    expect(review.findings).toEqual([]);
    const b = Object.values(model.nodes).find((n) => n.type === "boundaryEvent")!;
    const host = model.nodes[b.attachedToRef!];
    expect(host.name).toBe("Bauarbeiten ausführen");
    expect(b.eventDefinition).toBe("message");
    expect(b.cancelActivity).toBeUndefined(); // interrupting
    expect(b.lane).toBe(host.lane);
    // the first step of the exception path sits right of the activity, not at the far left
    const next = model.nodes[Object.values(model.edges).find((e) => e.source === b.id)!.target];
    expect(next.bounds.x).toBeGreaterThan(host.bounds.x);
    const m = measureLayout(model);
    expect(m.crossings).toBe(0);
    expect(m.maxDetour).toBeLessThanOrEqual(400);
    // survives BPMN XML and the way back to the AI format (editing)
    const back = importBpmn(exportBpmn(model));
    const b2 = Object.values(back.nodes).find((n) => n.type === "boundaryEvent")!;
    expect(b2.attachedToRef).toBe(host.id);
    const ir = modelToGraphIR(back).nodes.find((n) => n.type === "boundaryEvent")!;
    expect(ir).toMatchObject({ attachedTo: host.id, interrupting: true, event: "message" });
  });

  it("repairs what the norm does not allow, and says so", () => {
    const ir = base();
    const b = ir.nodes.find((n) => n.id === "bm")!;
    b.interrupting = false;
    b.event = "error"; // error cannot leave the activity running
    ir.flows.push({ from: "g1", to: "bm", condition: "", isDefault: false }); // no incoming flow allowed
    const lost = { ...b, id: "bx", attachedTo: "x1" }; // on a gateway → becomes an event in the flow
    ir.nodes.push(lost);
    const { ir: out, repairs } = sanitizeGraphIR(ir);
    expect(out.nodes.find((n) => n.id === "bm")).toMatchObject({ interrupting: true, event: "error" });
    expect(out.flows.some((f) => f.to === "bm")).toBe(false);
    expect(out.nodes.find((n) => n.id === "bx")).toMatchObject({ type: "intermediateCatchEvent", attachedTo: "" });
    expect(repairs.join(" ")).toMatch(/unterbrechend.*Eingang|Eingang.*unterbrechend/s);
    expect(repairs.join(" ")).toContain("hängt an keiner Aktivität");
  });

  it("an older AI answer without the new fields still works", () => {
    const ir = base();
    for (const n of ir.nodes as any[]) {
      delete n.attachedTo;
      delete n.interrupting;
    }
    ir.nodes = ir.nodes.filter((n) => n.type !== "boundaryEvent");
    ir.flows = ir.flows.filter((f) => f.from !== "bm");
    const { ir: out } = sanitizeGraphIR(ir);
    expect(out.nodes.every((n) => n.attachedTo === "" && n.interrupting === true)).toBe(true);
  });
});

describe("self-correction (one more AI round for violations of the standard)", () => {
  const sse = (body: string) => new Response(body, { headers: SSE_HEADERS });
  /** a process with an error event in the middle of the flow (10.5.4) */
  const broken = (): GraphIR => {
    const ir = sanitizeGraphIR({
      title: "Test",
      lang: "de",
      lanes: [],
      nodes: [
        { id: "s", type: "startEvent", name: "Antrag eingegangen", lane: "", event: "none", source: "", attachedTo: "", interrupting: true },
        { id: "t", type: "userTask", name: "Antrag prüfen", lane: "", event: "none", source: "", attachedTo: "", interrupting: true },
        { id: "f", type: "intermediateCatchEvent", name: "Fehler aufgetreten", lane: "", event: "error", source: "", attachedTo: "", interrupting: true },
        { id: "e", type: "endEvent", name: "Erledigt", lane: "", event: "none", source: "", attachedTo: "", interrupting: true },
      ],
      flows: [
        { from: "s", to: "t", condition: "", isDefault: false },
        { from: "t", to: "f", condition: "", isDefault: false },
        { from: "f", to: "e", condition: "", isDefault: false },
      ],
      pools: [],
      messageFlows: [],
      systems: [],
      dataObjects: [],
      assumptions: ["erste Runde"],
      ambiguities: [],
    }).ir;
    return ir;
  };

  it("is off by default: one call, the violation stays visible", async () => {
    let calls = 0;
    const res = await generateViaLlm("x", { fetchImpl: async () => (calls++, sse(claudeSse(broken()))) });
    expect(calls).toBe(1);
    expect(normViolations(res.model).map((i) => i.rule)).toContain("event.intermediate-trigger");
  });

  it("sends the violations back once and keeps the corrected diagram", async () => {
    const bodies: any[] = [];
    const phases: string[] = [];
    const res = await generateViaLlm("x", {
      selfCorrect: true,
      onProgress: (p) => phases.push(p.phase),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init!.body));
        bodies.push(body);
        if (!body.mode) return sse(claudeSse(broken()));
        // the AI turns the error event into a plain intermediate event
        const fixed = JSON.parse(JSON.stringify(body.graph));
        fixed.nodes.find((n: any) => n.event === "error").event = "none";
        fixed.nodes.find((n: any) => n.name === "Fehler aufgetreten").type = "intermediateThrowEvent";
        fixed.assumptions = ["Fehler als Meldung modelliert"];
        return sse(claudeSse(fixed));
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].mode).toBe("edit");
    expect(bodies[1].instruction).toContain("ISO/IEC 19510");
    expect(bodies[1].instruction).toContain("Norm 10.5.4");
    expect(bodies[1].instruction).toContain("„Fehler aufgetreten“");
    expect(phases).toContain("correcting");
    expect(normViolations(res.model)).toEqual([]);
    expect(res.review.findings?.[0]).toMatch(/^Selbstkorrektur: 1 von 1/);
    expect(res.review.assumptions).toEqual(["erste Runde", "Fehler als Meldung modelliert"]);
  });

  it("keeps the first draft when the correction does not help or fails", async () => {
    let n = 0;
    const same = await generateViaLlm("x", { selfCorrect: true, fetchImpl: async () => (n++, sse(claudeSse(broken()))) });
    expect(n).toBe(2);
    expect(same.review.findings?.[0]).toContain("Selbstkorrektur ohne Verbesserung");
    const failed = await generateViaLlm("x", {
      selfCorrect: true,
      fetchImpl: async (_u, init) => (JSON.parse(String(init!.body)).mode ? sse(claudeSse(broken(), { error: "overloaded_error" })) : sse(claudeSse(broken()))),
    });
    expect(failed.review.findings?.[0]).toContain("Selbstkorrektur fehlgeschlagen");
    expect(normViolations(failed.model).length).toBe(1);
  });

  it("a clean draft needs no second call", async () => {
    let calls = 0;
    await generateViaLlm("x", { selfCorrect: true, fetchImpl: async () => (calls++, sse(claudeSse(BAUETAPPE))) });
    expect(calls).toBe(1);
  });
});
