import { describe, expect, it } from "vitest";
import { applyEditedGraph, mapGraphToModel, modelToGraphIR, sanitizeGraphIR } from "../src/core/ai";
import { describeProcess, exportBpmn, importBpmn, measureLayout, validate } from "../src/core";
import { AUSSCHREIBUNG } from "./fixtures/processes";

const build = () => mapGraphToModel(sanitizeGraphIR(AUSSCHREIBUNG).ir).model;

describe("external pools and message flows", () => {
  it("keeps valid message flows and removes invalid ones with a repair note", () => {
    const { ir, repairs } = sanitizeGraphIR({
      lang: "de",
      nodes: [
        { id: "s", type: "startEvent", name: "S", lane: "", event: "message", source: "" },
        { id: "t", type: "sendTask", name: "Offerte senden", lane: "", event: "none", source: "" },
        { id: "e", type: "endEvent", name: "E", lane: "", event: "none", source: "" },
      ],
      flows: [
        { from: "s", to: "t", condition: "", isDefault: false },
        { from: "t", to: "e", condition: "", isDefault: false },
      ],
      pools: [{ id: "kunde", name: "Kunde" }, { id: "t", name: "Kollision mit Knoten-ID" }],
      messageFlows: [
        { from: "kunde", to: "s", name: "Anfrage" },
        { from: "t", to: "kunde", name: "Offerte" },
        { from: "t", to: "e", name: "innerhalb des Prozesses" },
        { from: "kunde", to: "kunde", name: "Pool zu Pool" },
      ],
    });
    expect(ir.pools).toEqual([{ id: "kunde", name: "Kunde" }]);
    expect(ir.messageFlows.map((m) => m.name)).toEqual(["Anfrage", "Offerte"]);
    expect(repairs.filter((r) => r.startsWith("Nachrichtenfluss"))).toHaveLength(2);
  });

  it("draws the client as a black-box pool above the process, with clean message flows", () => {
    const model = build();
    const client = Object.values(model.participants).find((p) => p.name === "Auftraggeber")!;
    const main = Object.values(model.participants).find((p) => p.processRef === model.rootProcessId)!;
    expect(client.processRef).toBeUndefined();
    expect(client.bounds.y + client.bounds.height).toBeLessThan(main.bounds.y);
    expect(client.bounds.width).toBe(main.bounds.width);

    const mfs = Object.values(model.edges).filter((e) => e.type === "messageFlow");
    expect(mfs).toHaveLength(8);
    for (const e of mfs) {
      const w = e.waypoints!;
      // orthogonal, and touching the client pool's lower border
      for (let i = 0; i < w.length - 1; i++) expect(w[i].x === w[i + 1].x || w[i].y === w[i + 1].y).toBe(true);
      const poolEnd = e.source === client.id ? w[0] : w[w.length - 1];
      expect(poolEnd.y).toBe(client.bounds.y + client.bounds.height);
    }
    const m = measureLayout(model);
    expect(m.overlaps + m.shapeHits + m.outsidePool + m.nodeOverlaps).toBe(0);
    expect(validate(model).filter((i) => i.rule.startsWith("messageflow"))).toEqual([]);
  });

  it("round-trips pools and message flows through BPMN XML", () => {
    const back = importBpmn(exportBpmn(build()));
    expect(Object.values(back.participants).map((p) => p.name)).toContain("Auftraggeber");
    expect(Object.values(back.edges).filter((e) => e.type === "messageFlow")).toHaveLength(8);
  });

  it("describes the communication with external partners", () => {
    const d = describeProcess(build());
    const client = d.partners.find((p) => p.name === "Auftraggeber")!;
    expect(client.messages.map((m) => m.name)).toContain("Offerte");
    const submit = d.steps.find((s) => s.name === "Offerte einreichen")!;
    expect(submit.messages).toEqual([{ direction: "out", partner: "Auftraggeber", name: "Offerte" }]);
  });

  it("keeps pools and message flows through an AI edit", () => {
    const model = build();
    const ir = modelToGraphIR(model);
    expect(ir.pools.map((p) => p.name)).toEqual(["Auftraggeber"]);
    expect(ir.messageFlows).toHaveLength(8);
    const { model: edited } = applyEditedGraph(model, sanitizeGraphIR(ir).ir);
    expect(Object.values(edited.edges).filter((e) => e.type === "messageFlow")).toHaveLength(8);
  });
});
