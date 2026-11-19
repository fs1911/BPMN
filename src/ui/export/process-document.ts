import type { jsPDF as JsPDF } from "jspdf";
import { heading, pdfText } from "./pdf";

/**
 * The compact process document: title, the profile (purpose, scope, owner,
 * version / release) and the diagram — nothing else, the diagram shows the
 * flow. As PDF (diagram as vector graphics) or Word (.docx, diagram as image,
 * editable text). Landscape, so the diagram is as large as possible. An
 * unreleased process is marked "Entwurf" on every page.
 */

export interface ProcessDocument {
  title: string;
  header: { label: string; value: string }[];
  date: string;
  released: boolean;
}

const ACCENT: [number, number, number] = [31, 58, 95];
const MUTED: [number, number, number] = [110, 120, 135];
const MARGIN = 14;

function svgSize(svg: string): { el: SVGSVGElement; w: number; h: number } {
  const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement as unknown as SVGSVGElement;
  const vb = el.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  return { el, w: Number(el.getAttribute("width")) || vb?.[2] || 1000, h: Number(el.getAttribute("height")) || vb?.[3] || 600 };
}

const rows = (d: ProcessDocument) => d.header.map((h) => [h.label, h.value.startsWith("(") ? "—" : h.value]);

export async function buildProcessDocumentPdf(svg: string, d: ProcessDocument): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }, { autoTable }] = await Promise.all([import("jspdf"), import("svg2pdf.js"), import("jspdf-autotable")]);
  const { el, w: svgW, h: svgH } = svgSize(svg);
  // A3 when the diagram would be too small on A4
  const a4Scale = Math.min((297 - 2 * MARGIN) / svgW, (210 - 80) / svgH);
  const format = a4Scale < 0.22 ? "a3" : "a4";
  const doc: JsPDF = new jsPDF({ orientation: "landscape", unit: "mm", format });
  doc.setProperties({ title: d.title, subject: "Prozessdokument", creator: "FlowCraft BPMN" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  heading(doc, pdfText(d.title), MARGIN, MARGIN + 5, 17);
  autoTable(doc, {
    startY: MARGIN + 9,
    body: rows(d).map(([l, v]) => [pdfText(l), pdfText(v)]),
    theme: "plain",
    styles: { fontSize: 9, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 }, textColor: [28, 37, 48], lineColor: [215, 222, 232], lineWidth: 0.2 },
    columnStyles: { 0: { cellWidth: 38, fontStyle: "bold", textColor: ACCENT, fillColor: [240, 244, 250] } },
    margin: { left: MARGIN, right: MARGIN },
  });
  const tableEnd = ((doc as any).lastAutoTable?.finalY as number | undefined) ?? MARGIN + 40;

  const areaTop = tableEnd + 6;
  const areaW = pageW - 2 * MARGIN;
  const areaH = pageH - areaTop - MARGIN - 6;
  const scale = Math.min(areaW / svgW, areaH / svgH);
  const w = svgW * scale;
  const h = svgH * scale;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
  host.appendChild(el);
  document.body.appendChild(host);
  try {
    await svg2pdf(el, doc, { x: MARGIN + (areaW - w) / 2, y: areaTop, width: w, height: h });
  } finally {
    host.remove();
  }

  doc.setDrawColor(210, 216, 225).setLineWidth(0.2).line(MARGIN, pageH - MARGIN + 2, pageW - MARGIN, pageH - MARGIN + 2);
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...MUTED);
  doc.text(pdfText(d.title), MARGIN, pageH - MARGIN + 6);
  doc.text(pdfText(`Stand ${d.date}`), pageW - MARGIN, pageH - MARGIN + 6, { align: "right" });
  if (!d.released) {
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(200, 60, 60);
    doc.text("ENTWURF – nicht freigegeben", pageW - MARGIN, MARGIN + 5, { align: "right" });
  }
  return doc.output("blob");
}

/** The diagram as PNG (white background), at most ~3000 px wide. */
async function svgToPng(svg: string): Promise<{ data: Uint8Array; w: number; h: number }> {
  const { w, h } = svgSize(svg);
  const scale = Math.min(2, 3000 / w);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Diagramm konnte nicht als Bild gespeichert werden."))), "image/png"));
  return { data: new Uint8Array(await blob.arrayBuffer()), w, h };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;

export async function buildProcessDocumentDocx(svg: string, d: ProcessDocument): Promise<Blob> {
  const [{ default: JSZip }, png] = await Promise.all([import("jszip"), svgToPng(svg)]);
  // A4 landscape in twentieths of a point; 1 twip = 635 EMU
  const pageW = 16838;
  const pageH = 11906;
  const margin = 850;
  const textW = pageW - 2 * margin;
  const maxImgH = pageH - 2 * margin - 3600; // room for title and profile
  const ratio = Math.min(textW / png.w, maxImgH / png.h);
  const cx = Math.round(png.w * ratio * 635);
  const cy = Math.round(png.h * ratio * 635);
  const accent = '<w:color w:val="1F3A5F"/>';
  const cell = (content: string, width: number, fill?: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${content}</w:p></w:tc>`;
  const labelW = 2400;
  const table = `<w:tbl><w:tblPr><w:tblW w:w="${textW}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="D7DEE8"/>`).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${labelW}"/><w:gridCol w:w="${textW - labelW}"/></w:tblGrid>${rows(d)
    .map(([l, v]) => `<w:tr>${cell(run(l, `<w:b/>${accent}<w:sz w:val="18"/>`), labelW, "F0F4FA")}${cell(run(v, '<w:sz w:val="18"/>'), textW - labelW)}</w:tr>`)
    .join("")}</w:tbl>`;
  const picture = `<w:p><w:pPr><w:spacing w:before="240"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Prozessdiagramm" descr="BPMN-Diagramm: ${xml(d.title)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="diagramm.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdDiagram"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const draft = d.released ? "" : `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run("ENTWURF – nicht freigegeben", '<w:b/><w:color w:val="C83C3C"/><w:sz w:val="20"/>')}</w:p>`;
  const body = `${draft}<w:p><w:pPr><w:spacing w:after="160"/></w:pPr>${run(d.title, `<w:b/>${accent}<w:sz w:val="36"/>`)}</w:p>${table}${picture}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${pageW}" w:h="${pageH}" w:orient="landscape"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr>`;
  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(d.title)}</dc:title><dc:creator>FlowCraft BPMN</dc:creator></cp:coreProperties>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDiagram" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/diagramm.png"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
  );
  zip.file(
    "word/footer1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${textW}"/></w:tabs></w:pPr>${run(d.title, '<w:color w:val="6E7887"/><w:sz w:val="16"/>')}<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:tab/></w:r>${run(`Stand ${d.date}`, '<w:color w:val="6E7887"/><w:sz w:val="16"/>')}</w:p></w:ftr>`,
  );
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`);
  zip.file("word/media/diagramm.png", png.data);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
