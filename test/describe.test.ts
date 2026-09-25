import { describe, expect, it } from "vitest";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { describeProcess, descriptionToMarkdown } from "../src/core";
import { BESTELLUNG, KREDIT } from "./fixtures/processes";

const build = (ir: typeof BESTELLUNG) => mapGraphToModel(sanitizeGraphIR(ir).ir).model;

describe("process description", () => {
  const model = build(BESTELLUNG);
  const d = describeProcess(model, { date: new Date("2026-09-25") });
  const step = (name: string) => d.steps.find((s) => s.name === name)!;

  it("numbers steps in reading order, short end branches right after their decision", () => {
    expect(d.steps[0].name).toBe("Bedarf festgestellt");
    expect(step("Anforderung abgelehnt").no).toBe(step("Freigegeben?").no + 1);
    // a join comes after all of its branches
    const join = d.steps.find((s) => s.kind === "parallel-join")!;
    expect(join.no).toBeGreaterThan(step("Wareneingang buchen").no);
    expect(join.no).toBeGreaterThan(step("Rechnung prüfen").no);
  });

  it("explains decisions, parallelism and loops from the model", () => {
    const g = step("Vollständig?");
    expect(g.kind).toBe("decision");
    expect(g.next.map((l) => l.label)).toEqual(["nein", "ja"]);
    expect(step("Anforderung ergänzen").next[0]).toMatchObject({ no: step("Anforderung prüfen").no, loop: true });
    const split = d.steps.find((s) => s.kind === "parallel-split")!;
    expect(split.description).toContain("laufen parallel");
    expect(d.stats).toMatchObject({ activities: 9, decisions: 3, parallel: 1, loops: 1, roles: 5 });
  });

  it("summarises triggers, outcomes, roles and the main path", () => {
    expect(d.triggers).toEqual(["Bedarf festgestellt"]);
    expect(d.outcomes).toContain("Anforderung abgelehnt");
    expect(d.roles.find((r) => r.name === "Buchhaltung")!.steps.map((s) => s.name)).toEqual(["Rechnung prüfen", "Zahlung freigeben"]);
    expect(d.mainPath[0]).toBe("Bedarf festgestellt");
    expect(d.mainPath).toContain("Anforderung freigeben");
    expect(d.mainPath[d.mainPath.length - 1]).toBe("Bestellung abgeschlossen");
    expect(d.summary).toContain("„Bestellprozess“");
  });

  it("uses element documentation and reports what is missing instead of inventing it", () => {
    const m = build(BESTELLUNG);
    const task = Object.values(m.nodes).find((n) => n.name === "Rechnung prüfen")!;
    task.documentation = "Sachliche und rechnerische Prüfung gegen Bestellung und Lieferschein.";
    const d2 = describeProcess(m);
    expect(d2.steps.find((s) => s.id === task.id)!.documentation).toContain("Lieferschein");
    expect(d2.openPoints[0]).toContain("8 von 9 Aktivitäten");
    expect(d2.header.every((h) => h.value === "(bitte ergänzen)")).toBe(true);
  });

  it("names unnamed gateways by their role and uses 'oder' for event-based choices", () => {
    const k = describeProcess(build(KREDIT));
    const eb = k.steps.find((s) => s.kind === "event-split")!;
    expect(eb.name).toBe("(Ereignis-Verzweigung)");
    expect(eb.description).toContain(" oder ");
    expect(k.steps.find((s) => s.kind === "inclusive-split")!.name).toBe("(Oder-Verzweigung)");
  });

  it("renders Markdown with the step table", () => {
    const md = descriptionToMarkdown(d);
    expect(md).toContain("# Prozessbeschreibung: Bestellprozess");
    expect(md).toContain("| Nr. | Schritt | Art | Verantwortlich | Beschreibung | Weiter |");
    expect(md).toContain("→ 3 (zurück)");
  });
});
