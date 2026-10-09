import { describe, expect, it } from "vitest";
import { cloneModel, createEdge, createNode, diffModels, emptyModel } from "../src/core";

describe("version comparison", () => {
  it("lists added, removed and changed elements by id, ignoring layout moves", () => {
    const old = emptyModel({ processId: "P" });
    createNode(old, "startEvent", { id: "s", name: "Start" });
    createNode(old, "task", { id: "a", name: "Antrag prüfen" });
    createNode(old, "task", { id: "b", name: "Antrag ablegen" });
    createNode(old, "endEvent", { id: "e", name: "Ende" });
    createEdge(old, "sequenceFlow", "s", "a", { id: "f1" });
    createEdge(old, "sequenceFlow", "a", "b", { id: "f2" });
    createEdge(old, "sequenceFlow", "b", "e", { id: "f3" });

    const cur = cloneModel(old);
    cur.nodes.a.name = "Antrag fachlich prüfen";
    cur.nodes.a.bounds = { ...cur.nodes.a.bounds, x: 999 }; // moved only: not a change
    cur.nodes.e.bounds = { ...cur.nodes.e.bounds, y: 500 };
    delete cur.nodes.b;
    delete cur.edges.f3;
    createNode(cur, "userTask", { id: "c", name: "Freigabe erteilen" });
    cur.edges.f2.target = "c";
    createEdge(cur, "sequenceFlow", "c", "e", { id: "f4" });

    const d = diffModels(old, cur);
    expect(d.added.sort()).toEqual(["c", "f4"]);
    expect(d.removed.sort()).toEqual(["b", "f3"]);
    expect(d.changed.map((c) => c.id).sort()).toEqual(["a", "f2"]);
    expect(d.lines).toContain("Neu: Benutzeraufgabe „Freigabe erteilen“");
    expect(d.lines).toContain("Entfernt: Aufgabe „Antrag ablegen“");
    expect(d.lines.join("\n")).toContain("Name: „Antrag prüfen“ → „Antrag fachlich prüfen“");
    expect(d.lines.join("\n")).toContain("neu verbunden");
    expect(diffModels(old, cloneModel(old)).lines).toEqual([]);
  });

  it("does not report renumbered but unchanged connections (AI edits renumber them)", () => {
    const old = emptyModel({ processId: "P" });
    createNode(old, "task", { id: "a", name: "A" });
    createNode(old, "task", { id: "b", name: "B" });
    createEdge(old, "sequenceFlow", "a", "b", { id: "f1", name: "ja" });
    const cur = cloneModel(old);
    const f = cur.edges.f1;
    delete cur.edges.f1;
    cur.edges.x9 = { ...f, id: "x9" };
    expect(diffModels(old, cur).lines).toEqual([]);
    cur.edges.x9.name = "nein";
    expect(diffModels(old, cur).lines).toEqual(["Geändert: Verbindung „A“ → „B“ („nein“) – Beschriftung: „ja“ → „nein“"]);
  });
});
