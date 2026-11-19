import { describe, expect, it } from "vitest";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { autoLayout, linkCrossings, measureLayout } from "../src/core";
import { simulationIssues } from "../src/core/simulation";
import { validate } from "../src/core/validation";
import { exportBpmn, importBpmn } from "../src/core/xml";
import { CORPUS } from "./fixtures/processes";

/**
 * Crossings the layout cannot avoid → link event pairs (on request, as preview).
 * Kept only where crossings drop; the process stays valid and behaves the same.
 */
describe("crossings → link events", () => {
  const { model } = mapGraphToModel(sanitizeGraphIR(CORPUS.ausschreibung).ir);
  const res = linkCrossings(model)!;

  it("tender: fewer crossings, no new defects, no long detours", () => {
    expect(res).toBeDefined();
    expect(res.after).toBeLessThan(res.before);
    expect(res.links.length).toBeGreaterThan(0);
    expect(res.links.length).toBeLessThanOrEqual(4);
    const m = measureLayout(res.model);
    expect(m.crossings).toBe(res.after);
    expect(m.overlaps + m.shapeHits + m.outsidePool + m.nodeOverlaps).toBe(0);
    expect(m.maxDetour).toBeLessThanOrEqual(700);
    // the input is untouched
    expect(Object.values(model.nodes).some((n) => n.eventDefinition === "link")).toBe(false);
  });

  it("each pair: one throw and one catch of the same name, named after where it leads", () => {
    for (const name of res.links) {
      const pair = Object.values(res.model.nodes).filter((n) => n.eventDefinition === "link" && n.name === name);
      expect(pair.map((n) => n.type).sort()).toEqual(["intermediateCatchEvent", "intermediateThrowEvent"]);
      expect(name).toMatch(/^[A-Z] – .+/);
      // the catching event stands just before its target, not at the far left
      const c = pair.find((n) => n.type === "intermediateCatchEvent")!;
      const next = Object.values(res.model.edges).find((e) => e.source === c.id)!;
      expect(res.model.nodes[next.target].bounds.x - c.bounds.x).toBeLessThan(300);
    }
  });

  it("valid by the standard, same behaviour in the simulation, survives export/import and cleanup", () => {
    expect(validate(res.model).filter((i) => i.severity === "error")).toEqual([]);
    const sim = (m: typeof model) => simulationIssues(m).filter((i) => i.severity === "error").length;
    expect(sim(res.model)).toBe(sim(model));
    const back = importBpmn(exportBpmn(res.model));
    expect(Object.values(back.nodes).filter((n) => n.eventDefinition === "link")).toHaveLength(2 * res.links.length);
    autoLayout(back, back.rootProcessId);
    expect(measureLayout(back).crossings).toBeLessThanOrEqual(res.after);
  });

  it("nothing to do without crossings", () => {
    expect(linkCrossings(mapGraphToModel(sanitizeGraphIR(CORPUS.bauetappe).ir).model)).toBeUndefined();
  });
});
