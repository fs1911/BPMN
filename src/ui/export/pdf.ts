import type { jsPDF as JsPDF } from "jspdf";
import type { ProcessDescription } from "@core/describe";
import { formatNext } from "@core/describe";

/**
 * Process documentation as PDF (Signavio/Q.wiki style):
 *   page 1   the diagram as vector graphics (A4 or A3 landscape, scaled to fit)
 *   page 2+  the process description: header data, summary, roles, the
 *            numbered step table and open points
 * with a running footer (title, date, "Seite x von y") on every page.
 *
 * The PDF libraries are loaded on demand so they do not weigh on app start.
 */

const ACCENT: [number, number, number] = [31, 58, 95];
const MUTED: [number, number, number] = [110, 120, 135];
const HEAD_FILL: [number, number, number] = [232, 238, 246];
const MARGIN = 14;

/** The standard PDF fonts only cover Windows-1252; map the few characters we use outside it. */
function pdfText(s: string): string {
  return s
    .replace(/→/g, "›")
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[✓✔]/g, "x")
    .replace(/[^\u0000-ÿ„“”‚‘’–—…€•›‹™]/g, "");
}

export async function buildProcessPdf(svg: string, d: ProcessDescription): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }, { autoTable }] = await Promise.all([
    import("jspdf"),
    import("svg2pdf.js"),
    import("jspdf-autotable"),
  ]);

  // --- Page 1: diagram
  const svgEl = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement as unknown as SVGSVGElement;
  const vb = svgEl.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  const svgW = Number(svgEl.getAttribute("width")) || vb?.[2] || 1000;
  const svgH = Number(svgEl.getAttribute("height")) || vb?.[3] || 600;
  const format = svgW > 1500 || svgH > 900 ? "a3" : "a4";
  const doc: JsPDF = new jsPDF({ orientation: "landscape", unit: "mm", format });
  doc.setProperties({ title: `Prozessbeschreibung: ${d.title}`, creator: "FlowCraft BPMN" });

  let pageW = doc.internal.pageSize.getWidth();
  let pageH = doc.internal.pageSize.getHeight();
  heading(doc, pdfText(d.title), MARGIN, MARGIN + 4, 16);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...MUTED);
  doc.text(pdfText(`Prozessmodell · Stand ${d.date}`), MARGIN, MARGIN + 10);

  const areaTop = MARGIN + 16;
  const areaW = pageW - 2 * MARGIN;
  const areaH = pageH - areaTop - MARGIN - 6;
  const scale = Math.min(areaW / svgW, areaH / svgH);
  const w = svgW * scale;
  const h = svgH * scale;
  // svg2pdf resolves styles via the DOM, so render from an attached (hidden) copy.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
  host.appendChild(svgEl);
  document.body.appendChild(host);
  try {
    await svg2pdf(svgEl, doc, { x: MARGIN + (areaW - w) / 2, y: areaTop, width: w, height: h });
  } finally {
    host.remove();
  }

  // --- Description pages (portrait A4)
  doc.addPage("a4", "portrait");
  pageW = doc.internal.pageSize.getWidth();
  pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - 2 * MARGIN;
  let y = MARGIN + 4;

  const ensure = (needed: number) => {
    if (y + needed > pageH - MARGIN - 8) {
      doc.addPage("a4", "portrait");
      y = MARGIN + 4;
    }
  };
  const h2 = (text: string) => {
    ensure(14);
    y += 4;
    heading(doc, pdfText(text), MARGIN, y, 12);
    y += 3;
    doc.setDrawColor(...HEAD_FILL).setLineWidth(0.6).line(MARGIN, y, pageW - MARGIN, y);
    y += 5;
  };
  const para = (text: string, opts: { bold?: boolean; size?: number } = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal").setFontSize(opts.size ?? 10).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(pdfText(text), contentW) as string[];
    for (const line of lines) {
      ensure(5);
      doc.text(line, MARGIN, y);
      y += 4.6;
    }
    y += 1.5;
  };
  const table = (options: Parameters<typeof autoTable>[1]) => {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, top: MARGIN + 4, bottom: MARGIN + 8 },
      theme: "grid",
      rowPageBreak: "avoid",
      styles: { font: "helvetica", fontSize: 8.5, cellPadding: 1.8, lineColor: [210, 216, 225], lineWidth: 0.2, textColor: [30, 30, 30], valign: "top" },
      headStyles: { fillColor: HEAD_FILL, textColor: ACCENT, fontStyle: "bold" },
      ...options,
    });
    y = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY ?? y) + 6;
  };

  heading(doc, pdfText(`Prozessbeschreibung: ${d.title}`), MARGIN, y, 16);
  y += 6;
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...MUTED);
  doc.text(pdfText(`Stand ${d.date} · automatisch aus dem BPMN-Modell erzeugt`), MARGIN, y);
  y += 6;

  table({
    body: [...d.header.map((h) => [h.label, h.value]), ["Auslöser", d.triggers.join("; ") || "—"], ["Ergebnisse", d.outcomes.join("; ") || "—"]].map(
      (r) => r.map(pdfText),
    ),
    columnStyles: { 0: { cellWidth: 42, fontStyle: "bold", textColor: ACCENT } },
    didParseCell: (data) => {
      if (data.column.index === 1 && data.cell.raw === "(bitte ergänzen)") data.cell.styles.textColor = MUTED;
    },
  });

  h2("Ablauf in Kürze");
  para(d.summary);
  if (d.mainPath.length) para(`Hauptablauf: ${d.mainPath.join(" › ")}`);

  if (d.roles.length) {
    h2("Rollen und Aufgaben");
    table({
      head: [["Rolle", "Aufgaben"]],
      body: d.roles.map((r) => [r.name, r.steps.map((s) => `${s.no}. ${s.name}`).join("\n") || "—"].map(pdfText)),
      columnStyles: { 0: { cellWidth: 45, fontStyle: "bold" } },
    });
  }

  h2("Ablauf im Detail");
  const gatewayKinds = new Set(["decision", "merge", "parallel-split", "parallel-join", "inclusive-split", "inclusive-join", "event-split"]);
  table({
    head: [["Nr.", "Schritt", "Art", "Verantwortlich", "Beschreibung", "Weiter"]],
    body: d.steps.map((s) =>
      [String(s.no), s.name, s.typeLabel, s.role, [s.description, s.documentation].filter(Boolean).join("\n") || "—", formatNext(s.next)].map(pdfText),
    ),
    columnStyles: {
      0: { cellWidth: 9, halign: "right" },
      1: { cellWidth: 33, fontStyle: "bold" },
      2: { cellWidth: 29 },
      3: { cellWidth: 27 },
      5: { cellWidth: 22 },
    },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const s = d.steps[data.row.index];
      if (gatewayKinds.has(s.kind)) data.cell.styles.fillColor = [248, 249, 251];
      if (s.kind === "start" || s.kind === "end") data.cell.styles.textColor = ACCENT;
    },
  });

  if (d.openPoints.length) {
    h2("Offene Punkte");
    for (const p of d.openPoints) para(`•  ${p}`, { size: 9.5 });
  }

  // --- Footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    doc.setDrawColor(210, 216, 225).setLineWidth(0.2).line(MARGIN, ph - MARGIN + 2, pw - MARGIN, ph - MARGIN + 2);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...MUTED);
    doc.text(pdfText(d.title), MARGIN, ph - MARGIN + 6);
    doc.text(pdfText(`Stand ${d.date}`), pw / 2, ph - MARGIN + 6, { align: "center" });
    doc.text(`Seite ${i} von ${pages}`, pw - MARGIN, ph - MARGIN + 6, { align: "right" });
  }

  return doc.output("blob");
}

function heading(doc: JsPDF, text: string, x: number, y: number, size: number): void {
  doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(...ACCENT);
  doc.text(text, x, y);
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** File-system friendly name from a process title. */
export function fileBase(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "prozess"
  );
}
