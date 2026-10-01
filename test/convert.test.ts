// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/core/convert/html-to-markdown";
import { pdfToMarkdown, type PdfPage, type PdfTextItem } from "../src/core/convert/pdf-to-markdown";

describe("Word (mammoth HTML) → Markdown", () => {
  it("keeps headings, numbered/nested lists, tables and emphasis", () => {
    const html = `
      <h1>Verfahrensanweisung Offerte</h1>
      <p>Inhaltsverzeichnis</p>
      <p>1 Zweck ........ 2</p>
      <h2>3 Ablauf</h2>
      <ol><li>Die <strong>Akquisition</strong> erfasst die Anfrage.</li>
          <li>Die Kalkulation prüft:<ul><li>Vollständigkeit</li><li>Fristen</li></ul></li></ol>
      <table><tr><td>Rolle</td><td>Aufgabe</td></tr><tr><td><p>Einkauf</p></td><td><p>Preise | anfragen</p></td></tr></table>
      <p><img src="x.png"></p>`;
    expect(htmlToMarkdown(html)).toBe(
      [
        "# Verfahrensanweisung Offerte",
        "",
        "Inhaltsverzeichnis",
        "",
        "## 3 Ablauf",
        "",
        "1. Die **Akquisition** erfasst die Anfrage.",
        "2. Die Kalkulation prüft:",
        "  - Vollständigkeit",
        "  - Fristen",
        "",
        "| Rolle | Aufgabe |",
        "| --- | --- |",
        "| Einkauf | Preise / anfragen |",
      ].join("\n"),
    );
  });
});

const run = (str: string, x: number, y: number, size = 10): PdfTextItem => ({ str, x, y, size, width: str.length * size * 0.5 });

describe("PDF text → Markdown", () => {
  const page = (items: PdfTextItem[]): PdfPage => ({ items, height: 842 });

  it("rebuilds headings, paragraphs, lists and hyphenation; drops running headers and page numbers", () => {
    const p1 = page([
      run("Musterbau AG – VA 7.2", 50, 800, 8),
      run("Offerte erstellen", 50, 700, 18),
      run("Die Kalkulation prüft die Unter-", 50, 660),
      run("lagen und meldet Lücken.", 50, 648),
      run("Ablauf", 50, 610, 13),
      run("•", 50, 580),
      run("Anfrage erfassen", 62, 580),
      run("1.", 50, 566),
      run("Preise anfragen", 62, 566),
      run("Rolle", 50, 530),
      run("Aufgabe", 250, 530),
      run("Seite 1 von 2", 280, 40, 8),
    ]);
    const p2 = page([run("Musterbau AG – VA 7.2", 50, 800, 8), run("Die Geschäftsleitung gibt die Offerte frei.", 50, 700), run("Seite 2 von 2", 280, 40, 8)]);
    const r = pdfToMarkdown([p1, p2]);
    expect(r.scanned).toBe(false);
    expect(r.markdown).toBe(
      [
        "# Offerte erstellen",
        "",
        "Die Kalkulation prüft die Unterlagen und meldet Lücken.",
        "",
        "## Ablauf",
        "",
        "- Anfrage erfassen",
        "1. Preise anfragen",
        "",
        "| Rolle | Aufgabe |",
        "| --- | --- |",
        "",
        "Die Geschäftsleitung gibt die Offerte frei.",
      ].join("\n"),
    );
  });

  it("leaves out pages that are a drawn diagram (scattered short labels)", () => {
    const labels = Array.from({ length: 30 }, (_, i) => run(i % 2 ? "ja" : "Offerte prüfen", 40 + ((i * 37) % 700), 100 + ((i * 53) % 600)));
    const r = pdfToMarkdown([page(labels), page([run("Die Kalkulation prüft die Offerte.", 50, 700)])]);
    expect(r.diagramPages).toEqual([1]);
    expect(r.markdown).toBe("Die Kalkulation prüft die Offerte.");
  });

  it("flags a scan (no text layer)", () => {
    const r = pdfToMarkdown([page([]), page([run("12", 50, 40)])]);
    expect(r.scanned).toBe(true);
  });
});
