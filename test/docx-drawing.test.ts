// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { drawingsToMarkdown, readFlowDrawings } from "../src/core/convert/docx-drawing";

/**
 * Flowcharts drawn with Word shapes, as Word stores them: a group of shapes
 * (wps:wsp) with connectors glued to them (a:stCxn / a:endCxn) or loose
 * (id 4294967295, matched by position), and small text boxes as arrow labels.
 * Built like the real "Kreditorenprozess" document that produced only box
 * texts without arrows.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
/** positions in 1/1000 of a Word unit (EMU) to keep the cases readable: 1000 ≈ 1 mm */
const k = (v: number) => v * 1000;
const box = (id: number, prst: string, x: number, y: number, w: number, h: number, text: string) =>
  `<wps:wsp><wps:cNvPr id="${id}" name="s${id}"/><wps:spPr><a:xfrm><a:off x="${k(x)}" y="${k(y)}"/><a:ext cx="${k(w)}" cy="${k(h)}"/></a:xfrm><a:prstGeom prst="${prst}"/></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>`;
const arrow = (id: number, x: number, y: number, w: number, h: number, from?: number, to?: number, flipH = false, prst = "straightConnector1") =>
  `<wps:wsp><wps:cNvPr id="${id}" name="c${id}"/><wps:cNvCnPr><a:stCxn id="${from ?? 4294967295}" idx="2"/><a:endCxn id="${to ?? 4294967295}" idx="0"/></wps:cNvCnPr><wps:spPr><a:xfrm${flipH ? ' flipH="1"' : ""}><a:off x="${k(x)}" y="${k(y)}"/><a:ext cx="${k(w)}" cy="${k(h)}"/></a:xfrm><a:prstGeom prst="${prst}"/></wps:spPr></wps:wsp>`;
const doc = (...groups: string[][]) =>
  `<w:document ${W}><w:body>${groups
    .map((g) => `<w:p><w:r><w:drawing><wp:anchor><wpg:wgp>${g.join("")}</wpg:wgp></wp:anchor></w:drawing></w:r></w:p>`)
    .join("")}<w:p><w:r><w:t>Zweck: Führung der Kreditorenbuchhaltung</w:t></w:r></w:p></w:body></w:document>`;

// Start → Prüfen → Korrekt? –Ja→ Visieren → Ende ; –Nein→ Zurückweisen → Ende (bent arrow)
const glued = [
  box(2, "flowChartTerminator", 1000, 0, 1000, 250, "Start"),
  box(3, "flowChartProcess", 1000, 500, 1000, 250, "Rechnung prüfen"),
  box(4, "flowChartDecision", 900, 1000, 1200, 600, "Beleg korrekt?"),
  box(5, "flowChartProcess", 1000, 2000, 1000, 250, "Rechnung visieren"),
  box(6, "flowChartProcess", 3000, 1175, 1000, 250, "Rechnung zurückweisen"),
  box(7, "flowChartTerminator", 1000, 2600, 1000, 250, "Ende"),
  arrow(10, 1500, 250, 0, 250, 2, 3),
  arrow(11, 1500, 750, 0, 250, 3, 4),
  arrow(12, 1500, 1600, 0, 400, 4, 5),
  arrow(13, 2100, 1300, 900, 0, 4, 6),
  arrow(14, 1500, 2250, 0, 350, 5, 7),
  arrow(15, 2000, 1425, 1500, 1300, 6, 7, true, "bentConnector2"),
  box(20, "rect", 1500, 1650, 200, 120, "Ja"),
  box(21, "rect", 2150, 1180, 250, 120, "Nein"),
  box(22, "textNoShape", 5000, 0, 1500, 200, "Zuständig: Buchhaltung"),
];
// Loose arrows (not glued in Word): matched by where they start and end
const loose = [
  box(82, "flowChartTerminator", 0, 0, 1000, 250, "Start"),
  box(83, "flowChartProcess", 0, 500, 1000, 250, "Zahllauf im Abacus erstellen"),
  box(84, "flowChartTerminator", 0, 1000, 1000, 250, "Ende"),
  arrow(87, 500, 250, 0, 250),
  arrow(88, 500, 750, 0, 250),
];

describe("flowcharts drawn in Word", () => {
  const drawings = readFlowDrawings(doc(glued, loose));

  it("reads shapes, decisions and glued arrows with their Ja/Nein labels", () => {
    const [d] = drawings;
    const name = (id: string) => d.shapes.find((s) => s.id === id)!.text;
    const flows = d.flows.map((f) => `${name(f.from)} → ${name(f.to)}${f.label ? ` [${f.label}]` : ""}`);
    expect(flows).toEqual([
      "Start → Rechnung prüfen",
      "Rechnung prüfen → Beleg korrekt?",
      "Beleg korrekt? → Rechnung visieren [Ja]",
      "Beleg korrekt? → Rechnung zurückweisen [Nein]",
      "Rechnung visieren → Ende",
      "Rechnung zurückweisen → Ende",
    ]);
    expect(d.shapes.find((s) => s.text === "Beleg korrekt?")!.kind).toBe("decision");
    expect(d.shapes.filter((s) => s.kind === "start-end").map((s) => s.text)).toEqual(["Start", "Ende"]);
    // labels are not steps; a text box away from every arrow is kept as a note
    expect(d.shapes.map((s) => s.text)).not.toContain("Ja");
    expect(d.notes).toEqual(["Zuständig: Buchhaltung"]);
  });

  it("matches loose arrows to the shapes at their ends", () => {
    const d = drawings[1];
    const name = (id: string) => d.shapes.find((s) => s.id === id)!.text;
    expect(d.flows.map((f) => `${name(f.from)} → ${name(f.to)}`)).toEqual(["Start → Zahllauf im Abacus erstellen", "Zahllauf im Abacus erstellen → Ende"]);
  });

  it("states the flow for the AI: every shape with an id, every arrow with its label", () => {
    const md = drawingsToMarkdown(drawings);
    expect(md).toContain("## Ablaufzeichnung 1 aus dem Word-Dokument");
    expect(md).toContain("- [Z1.3] Beleg korrekt? (Entscheidung)");
    expect(md).toMatch(/- Z1\.3 → Z1\.\d+ \[Nein\]/);
    expect(md).toContain("## Ablaufzeichnung 2");
    expect(md).toContain("Weitere Texte in der Zeichnung:\n- Zuständig: Buchhaltung");
  });

  it("ignores documents without drawn arrows", () => {
    expect(readFlowDrawings(`<w:document ${W}><w:body><w:p><w:r><w:t>Nur Text</w:t></w:r></w:p></w:body></w:document>`)).toEqual([]);
  });
});
