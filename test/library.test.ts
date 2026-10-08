import { describe, expect, it } from "vitest";
import { copyName, makeBackup, mergeBackup, parseBackup, type StoredProcess } from "../src/core/library/library";

const proc = (id: string, updatedAt: string, name = id): StoredProcess => ({
  id,
  name,
  xml: '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>',
  sourceText: "Text",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

describe("process library", () => {
  it("round-trips a backup file", () => {
    const all = [proc("a", "2026-10-01T10:00:00.000Z"), proc("b", "2026-10-02T10:00:00.000Z")];
    expect(parseBackup(JSON.stringify(makeBackup(all)))).toEqual(all);
  });

  it("rejects files that are not a FlowCraft backup and drops broken entries", () => {
    expect(() => parseBackup("kein json")).toThrow(/kein gültiges JSON/);
    expect(() => parseBackup(JSON.stringify({ processes: [] }))).toThrow(/keine FlowCraft-Sicherung/);
    expect(() => parseBackup(JSON.stringify({ format: "flowcraft-library", version: 9, processes: [] }))).toThrow(/Version 9|Sicherungsversion 9/);
    const broken = { ...makeBackup([proc("ok", "2026-10-01T00:00:00.000Z")]) };
    (broken.processes as unknown[]).push({ id: "x", name: "ohne xml", updatedAt: "2026" }, null);
    expect(parseBackup(JSON.stringify(broken)).map((p) => p.id)).toEqual(["ok"]);
  });

  it("restores: new ids added, newer versions replace, older or equal ones are skipped", () => {
    const existing = [proc("a", "2026-10-05T00:00:00.000Z"), proc("b", "2026-10-01T00:00:00.000Z")];
    const incoming = [proc("a", "2026-10-03T00:00:00.000Z"), proc("b", "2026-10-04T00:00:00.000Z"), proc("c", "2026-10-02T00:00:00.000Z")];
    const r = mergeBackup(existing, incoming);
    expect({ added: r.added, updated: r.updated, skipped: r.skipped }).toEqual({ added: 1, updated: 1, skipped: 1 });
    expect(r.write.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("names copies without clashes", () => {
    expect(copyName("Offerte", ["Offerte"])).toBe("Offerte (Kopie)");
    expect(copyName("Offerte", ["Offerte", "Offerte (Kopie)"])).toBe("Offerte (Kopie 2)");
    expect(copyName("Offerte (Kopie)", ["Offerte", "Offerte (Kopie)", "Offerte (Kopie 2)"])).toBe("Offerte (Kopie 3)");
  });
});
