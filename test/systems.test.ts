import { describe, expect, it } from "vitest";
import { mapGraphToModel, modelToGraphIR, sanitizeGraphIR, type GraphIR } from "../src/core/ai";
import { autoLayout, measureLayout, rerouteOnly } from "../src/core";
import { exportBpmn, importBpmn } from "../src/core/xml";
import { validate } from "../src/core/validation";

/**
 * Systems a step is done in (Abacus, DocuWare, Sorba, …): a data store symbol
 * directly below the step, linked by a data association; room for it is made
 * in the layout, and it survives export, import, cleanup and AI editing.
 */

const node = (id: string, type: string, name: string, lane: string, systems: string[] = []) => ({
  id,
  type,
  name,
  lane,
  event: "none",
  source: name,
  attachedTo: "",
  interrupting: true,
  systems,
});
const flow = (from: string, to: string, condition = "") => ({ from, to, condition, isDefault: false });

const RECHNUNG: GraphIR = {
  title: "Rechnung verarbeiten",
  purpose: "Lieferantenrechnungen korrekt und fristgerecht verbuchen.",
  scope: "Alle Gesellschaften",
  owner: "Leitung Finanzbuchhaltung",
  lang: "de",
  lanes: [
    { id: "l1", name: "Kreditorenbuchhaltung" },
    { id: "l2", name: "Visumsverantwortlicher" },
  ],
  nodes: [
    node("s", "startEvent", "Rechnung eingegangen", "l1"),
    node("t1", "userTask", "Rechnung einlesen", "l1", ["Abacus", "DocuWare"]),
    node("t2", "userTask", "Rechnung verbuchen", "l1", ["Abacus"]),
    node("g", "exclusiveGateway", "Beleg korrekt?", "l2"),
    node("t3", "userTask", "Rechnung visieren", "l2", ["Abacus"]),
    node("t4", "userTask", "Rechnung zurückweisen", "l2"),
    node("t5", "userTask", "Lohnstunden erfassen", "l1", ["Sorba"]),
    node("e1", "endEvent", "Rechnung visiert", "l2"),
    node("e2", "endEvent", "Rechnung zurückgewiesen", "l2"),
  ] as GraphIR["nodes"],
  flows: [flow("s", "t1"), flow("t1", "t2"), flow("t2", "g"), flow("g", "t3", "ja"), flow("g", "t4", "nein"), flow("t3", "t5"), flow("t5", "e1"), flow("t4", "e2")],
  pools: [],
  messageFlows: [],
  systems: ["Abacus", "DocuWare", "Sorba"],
  dataObjects: [],
  assumptions: [],
  ambiguities: [],
};

const stores = (m: ReturnType<typeof mapGraphToModel>["model"]) => Object.values(m.nodes).filter((n) => n.type === "dataStoreReference");
const linksOf = (m: ReturnType<typeof mapGraphToModel>["model"], taskName: string) => {
  const task = Object.values(m.nodes).find((n) => n.name === taskName)!;
  return Object.values(m.edges)
    .filter((e) => e.type === "association" && e.source === task.id)
    .map((e) => m.nodes[e.target]);
};
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("systems as data stores next to their step", () => {
  const { model, review } = mapGraphToModel(sanitizeGraphIR(RECHNUNG).ir);

  it("one symbol per step and system, linked to the step, listed in the review", () => {
    expect(stores(model).map((s) => s.name).sort()).toEqual(["Abacus", "Abacus", "Abacus", "DocuWare", "Sorba"]);
    expect(linksOf(model, "Rechnung einlesen").map((n) => n.name).sort()).toEqual(["Abacus", "DocuWare"]);
    expect(review.systems).toEqual(["Abacus", "DocuWare", "Sorba"]);
    // data stores are no lane members
    expect(stores(model).every((s) => !s.lane)).toBe(true);
  });

  it("sits directly below its step, inside the pool, on nothing else", () => {
    const others = Object.values(model.nodes).filter((n) => n.type !== "dataStoreReference");
    const pool = Object.values(model.participants)[0].bounds;
    for (const s of stores(model)) {
      const task = model.nodes[Object.values(model.edges).find((e) => e.target === s.id)!.source];
      expect(s.bounds.y).toBeGreaterThanOrEqual(task.bounds.y + task.bounds.height);
      expect(s.bounds.y - (task.bounds.y + task.bounds.height)).toBeLessThan(40);
      expect(Math.abs(s.bounds.x + s.bounds.width / 2 - (task.bounds.x + task.bounds.width / 2))).toBeLessThanOrEqual(40);
      expect(others.filter((o) => overlap(o.bounds, s.bounds))).toEqual([]);
      expect(s.bounds.y + s.bounds.height + 20).toBeLessThanOrEqual(pool.y + pool.height);
      // the link is a short vertical line from the step down to the symbol
      const link = Object.values(model.edges).find((e) => e.target === s.id)!;
      expect(link.waypoints).toHaveLength(2);
      expect(link.waypoints![0].x).toBe(link.waypoints![1].x);
    }
    const m = measureLayout(model);
    expect(m.crossings + m.overlaps + m.shapeHits + m.nodeOverlaps).toBe(0);
  });

  it("no flow runs through a symbol", () => {
    for (const e of Object.values(model.edges).filter((x) => x.type === "sequenceFlow")) {
      for (let i = 0; i < e.waypoints!.length - 1; i++) {
        const [a, b] = [e.waypoints![i], e.waypoints![i + 1]];
        const seg = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) || 1, height: Math.abs(a.y - b.y) || 1 };
        for (const s of stores(model)) expect(overlap(seg, s.bounds)).toBe(false);
      }
    }
  });

  it("survives BPMN export/import (data output association), cleanup and the way back to the AI format", () => {
    const xml = exportBpmn(model);
    expect(xml).toMatch(/<bpmn:dataOutputAssociation id="[^"]+"><bpmn:targetRef>[^<]+<\/bpmn:targetRef><\/bpmn:dataOutputAssociation>/);
    expect(xml).not.toMatch(/<bpmn:association [^>]*dataStore/);
    const back = importBpmn(xml);
    expect(stores(back as any)).toHaveLength(5);
    expect(linksOf(back as any, "Rechnung einlesen").map((n) => n.name).sort()).toEqual(["Abacus", "DocuWare"]);
    autoLayout(back, back.rootProcessId);
    rerouteOnly(back, back.rootProcessId);
    const t1 = Object.values(back.nodes).find((n) => n.name === "Rechnung einlesen")!;
    for (const s of linksOf(back as any, "Rechnung einlesen")) expect(s.bounds.y).toBeGreaterThan(t1.bounds.y + t1.bounds.height);
    const ir = modelToGraphIR(back);
    expect(ir.nodes.find((n) => n.name === "Rechnung einlesen")!.systems.sort()).toEqual(["Abacus", "DocuWare"]);
    expect(ir.nodes.some((n) => (n.type as string) === "dataStoreReference")).toBe(false);
    expect(validate(back).filter((i) => i.severity === "error")).toEqual([]);
  });
});
