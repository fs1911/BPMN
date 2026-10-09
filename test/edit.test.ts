import { SSE_HEADERS, claudeSse } from "../scripts/lib/claude-sse.mjs";
import { describe, expect, it } from "vitest";
import {
  applyEditedGraph,
  diffGraphs,
  editViaLlm,
  mapGraphToModel,
  modelToGraphIR,
  sanitizeGraphIR,
} from "../src/core/ai";
import type { GraphIR } from "../src/core/ai/graph-schema";
import { createNode, measureLayout } from "../src/core";
import { BESTELLUNG } from "./fixtures/processes";

const build = () => mapGraphToModel(sanitizeGraphIR(BESTELLUNG).ir).model;
const byName = (ir: GraphIR, name: string) => ir.nodes.find((n) => n.name === name)!;

/** What an LLM returns for "Nach der Rechnungsprüfung eine Freigabe durch die Teamleitung einfügen". */
function insertApproval(before: GraphIR): GraphIR {
  const ir: GraphIR = JSON.parse(JSON.stringify(before));
  const check = byName(ir, "Rechnung prüfen");
  const flow = ir.flows.find((f) => f.from === check.id)!;
  ir.lanes.push({ id: "new_lane", name: "Teamleitung" });
  ir.nodes.push({ id: "new1", type: "userTask", name: "Rechnung freigeben", lane: "new_lane", event: "none", source: "Freigabe durch die Teamleitung", attachedTo: "", interrupting: true });
  ir.flows.push({ from: "new1", to: flow.to, condition: "", isDefault: false });
  flow.to = "new1";
  return ir;
}

describe("AI editing of an existing diagram", () => {
  it("round-trips the diagram through Graph IR with its own ids", () => {
    const model = build();
    const ir = modelToGraphIR(model);
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(Object.keys(model.nodes).sort());
    expect(ir.lanes.map((l) => l.name)).toEqual(["Anforderer", "Einkauf", "Abteilungsleitung", "System", "Buchhaltung"]);
    const { model: again } = applyEditedGraph(model, sanitizeGraphIR(ir).ir);
    expect(Object.keys(again.nodes).sort()).toEqual(Object.keys(model.nodes).sort());
    expect(diffGraphs(ir, modelToGraphIR(again)).summary).toBe("Keine Änderung am Diagramm.");
  });

  it("applies an insertion, keeps ids and everything the LLM never sees", () => {
    const model = build();
    const task = Object.values(model.nodes).find((n) => n.name === "Anforderung prüfen")!;
    task.documentation = "Vollständigkeit und Budget prüfen.";
    const timer = createNode(model, "boundaryEvent", { name: "3 Tage", eventDefinition: "timer", attachedToRef: task.id, parent: model.rootProcessId });

    const before = modelToGraphIR(model);
    const after = insertApproval(before);
    const { model: edited } = applyEditedGraph(model, sanitizeGraphIR(after).ir);

    expect(edited.nodes[task.id].documentation).toBe("Vollständigkeit und Budget prüfen.");
    expect(edited.nodes[timer.id]).toMatchObject({ type: "boundaryEvent", attachedToRef: task.id });
    expect(edited.nodes.new1.name).toBe("Rechnung freigeben");
    for (const id of Object.keys(model.nodes)) expect(edited.nodes[id], id).toBeDefined();

    const diff = diffGraphs(before, after);
    expect(diff.added).toEqual(["new1"]);
    expect(diff.removed).toEqual([]);
    expect(diff.summary).toContain("1 Element(e) hinzugefügt");

    const m = measureLayout(edited);
    expect(m.overlaps + m.shapeHits + m.outsidePool + m.nodeOverlaps).toBe(0);
  });

  it("keeps unchanged elements in their lanes and the lane order", () => {
    const model = build();
    const before = modelToGraphIR(model);
    const { model: edited } = applyEditedGraph(model, sanitizeGraphIR(insertApproval(before)).ir);
    const laneName = (m: typeof model, id: string) => m.lanes[m.nodes[id].lane!]?.name;
    for (const id of Object.keys(model.nodes)) expect(laneName(edited, id)).toBe(laneName(model, id));
    const order = (m: typeof model) => Object.values(m.lanes).sort((a, b) => a.bounds.y - b.bounds.y).map((l) => l.name);
    expect(order(edited).filter((n) => n !== "Teamleitung")).toEqual(order(model));
  });

  it("reports removals by name and warns about elements it cannot carry over", () => {
    const model = build();
    createNode(model, "textAnnotation", { name: "Hinweis", parent: model.rootProcessId });
    const before = modelToGraphIR(model);
    const after: GraphIR = JSON.parse(JSON.stringify(before));
    const drop = byName(after, "Anforderung ergänzen");
    after.nodes = after.nodes.filter((n) => n.id !== drop.id);
    after.flows = after.flows.filter((f) => f.from !== drop.id && f.to !== drop.id);
    const diff = diffGraphs(before, after);
    expect(diff.removedNames).toEqual(["Anforderung ergänzen"]);
    const { review } = applyEditedGraph(model, sanitizeGraphIR(after).ir);
    expect(review.findings![0]).toContain("1 Anmerkung(en)");
  });

  it("sends the current diagram and the instruction to the endpoint", async () => {
    const model = build();
    let sent: any;
    const res = await editViaLlm(model, "Freigabe durch die Teamleitung nach der Rechnungsprüfung", {
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init!.body));
        const graph = insertApproval(sent.graph);
        return new Response(claudeSse(graph), { headers: SSE_HEADERS });
      },
    });
    expect(sent.mode).toBe("edit");
    expect(sent.instruction).toContain("Teamleitung");
    expect(sent.graph.nodes).toHaveLength(Object.keys(model.nodes).length);
    expect(res.diff.added).toEqual(["new1"]);
    expect(res.model.nodes.new1).toBeDefined();
  });

  it("makes LLM ids safe for BPMN XML", () => {
    const { ir } = sanitizeGraphIR({
      lang: "de",
      nodes: [
        { id: "1", type: "startEvent", name: "S", lane: "", event: "none", source: "" },
        { id: "neu 2", type: "endEvent", name: "E", lane: "", event: "none", source: "" },
      ],
      flows: [{ from: "1", to: "neu 2", condition: "", isDefault: false }],
    });
    expect(ir.nodes.map((n) => n.id)).toEqual(["id_1", "id_neu_2"]);
    expect(ir.flows[0]).toMatchObject({ from: "id_1", to: "id_neu_2" });
  });
});
