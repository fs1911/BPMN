import { htmlToMarkdown } from "@core/convert/html-to-markdown";
import { pdfToMarkdown, type PdfPage } from "@core/convert/pdf-to-markdown";
import { drawingsToMarkdown, readFlowDrawings } from "@core/convert/docx-drawing";
import { MAX_IMAGES } from "@core/ai";
import { base64ToAttachment, canvasToAttachment, imageFileToAttachment, type ImageAttachment } from "./images";

/**
 * Word / PDF file or photo → Markdown and images, in the browser. The file
 * itself never leaves the machine: the Markdown the user reviewed in the text
 * field and the shrunk images listed under it are what is sent to the AI.
 * Pictures inside a Word file, scanned PDF pages and PDF pages that hold a
 * diagram become images; text stays text (far fewer tokens). The converter
 * libraries are loaded on first use so the editor itself stays small.
 */

export interface ImportedDocument {
  markdown: string;
  /** user-facing notes (scan detected, images ignored, …) */
  warnings: string[];
  /** pictures for the AI (photos, scanned pages, diagrams) */
  images: ImageAttachment[];
}

const IMAGE_FILE = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** `slots`: how many more images may be added (the AI takes at most MAX_IMAGES). */
export async function documentToMarkdown(file: File, slots = MAX_IMAGES): Promise<ImportedDocument> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`Datei zu gross (${Math.round(file.size / 1024 / 1024)} MB, maximal 25 MB).`);
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) return docx(file, slots);
  if (name.endsWith(".pdf")) return pdf(file, slots);
  if (IMAGE_FILE.test(name) || file.type.startsWith("image/")) {
    if (!slots) return { markdown: "", warnings: [`„${file.name}“ nicht übernommen – höchstens ${MAX_IMAGES} Bilder pro Generierung.`], images: [] };
    return { markdown: "", warnings: [], images: [await imageFileToAttachment(file)] };
  }
  if (name.endsWith(".doc")) throw new Error("Alte Word-Dateien (.doc) werden nicht unterstützt – bitte in Word als .docx speichern.");
  throw new Error("Unterstützt werden Word (.docx), PDF und Fotos (JPG, PNG, WebP).");
}

async function docx(file: File, slots: number): Promise<ImportedDocument> {
  const [mammoth, { default: JSZip }] = await Promise.all([import("mammoth"), import("jszip")]);
  const buffer = await file.arrayBuffer();
  const embedded: { data: string; type: string }[] = [];
  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer: buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        embedded.push({ data: await image.read("base64"), type: image.contentType });
        return { src: "" };
      }),
    },
  );
  let markdown = htmlToMarkdown(html);
  const warnings: string[] = [];
  // A flowchart drawn with Word shapes: the text extraction above holds only
  // the words in the boxes; the arrows are read from the drawing itself.
  const xml = await (await JSZip.loadAsync(buffer)).file("word/document.xml")?.async("string");
  const drawings = xml ? readFlowDrawings(xml).filter((d) => d.flows.length >= 2) : [];
  if (drawings.length) {
    const drawn = new Set(drawings.flatMap((d) => [...d.shapes.map((s) => s.text), ...d.flows.map((f) => f.label ?? ""), ...d.notes]).filter(Boolean));
    const rest = markdown
      .split(/\n{2,}/)
      .filter((para) => !drawn.has(para.replace(/[*_]/g, "").replace(/\s+/g, " ").trim()))
      .join("\n\n")
      .trim();
    markdown = [drawingsToMarkdown(drawings), rest && `## Weitere Angaben aus dem Dokument\n\n${rest}`].filter(Boolean).join("\n\n");
    const counts = drawings.map((d) => `${d.shapes.length} Formen, ${d.flows.length} Pfeile`).join(" und ");
    warnings.push(`Ablaufzeichnung erkannt (${counts}) – Schritte, Entscheidungen und Pfeile wurden aus der Zeichnung übernommen.`);
  }
  // Pictures (a drawn flowchart, a photo of the board) go to the AI as images; icons and logos are skipped.
  const images: ImageAttachment[] = [];
  let skipped = 0;
  for (const [i, img] of embedded.entries()) {
    const att = await base64ToAttachment(img.data, img.type, `Bild ${i + 1} aus ${file.name}`);
    if (!att) continue;
    if (images.length < slots) images.push(att);
    else skipped++;
  }
  if (images.length) warnings.push(`${images.length} Bild(er) aus dem Dokument werden mitgeschickt – unten prüfen und unnötige entfernen.`);
  if (skipped) warnings.push(`${skipped} weitere(s) Bild(er) nicht übernommen – höchstens ${MAX_IMAGES} pro Generierung.`);
  if (!markdown.trim() && !images.length) warnings.push("Im Dokument wurde kein Text gefunden.");
  return { markdown, warnings, images };
}

async function pdf(file: File, slots: number): Promise<ImportedDocument> {
  // Legacy build: the modern one relies on brand-new JS (Math.sumPrecise) and
  // silently returns truncated text in browsers that lack it.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: PdfPage[] = [];
  const warnings: string[] = [];
  const images: ImageAttachment[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: PdfPage["items"] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const [a, b, , , x, y] = it.transform as number[];
        items.push({ str: it.str, x, y, width: it.width, size: Math.hypot(a, b) || it.height });
      }
      pages.push({ items, height: page.getViewport({ scale: 1 }).height });
      page.cleanup();
    }
    const result = pdfToMarkdown(pages);
    // Scans and diagram pages carry no usable text: the AI gets them as pictures.
    const asImages = result.scanned ? pages.map((_, i) => i + 1) : result.diagramPages;
    const rendered = asImages.slice(0, slots);
    for (const n of rendered) images.push(await renderPage(doc, n, `Seite ${n} von ${file.name}`));
    if (rendered.length) {
      warnings.push(
        result.scanned
          ? `Das PDF enthält (fast) keinen Text – vermutlich ein Scan. ${rendered.length === 1 ? "Die Seite wird" : `${rendered.length} Seiten werden`} als Bild an die KI geschickt.`
          : `Seite ${rendered.join(", ")} ${rendered.length === 1 ? "sieht" : "sehen"} nach einer Grafik/einem Diagramm aus und ${rendered.length === 1 ? "wird" : "werden"} als Bild mitgeschickt.`,
      );
    }
    if (asImages.length > rendered.length) {
      warnings.push(`Seite ${asImages.slice(rendered.length).join(", ")} nicht als Bild übernommen – höchstens ${MAX_IMAGES} Bilder pro Generierung.`);
    }
    return { markdown: result.markdown, warnings, images };
  } finally {
    void doc.destroy();
  }
}

/** One PDF page drawn at about 1600 px on its long side. */
async function renderPage(doc: { getPage(n: number): Promise<any> }, n: number, name: string): Promise<ImageAttachment> {
  const page = await doc.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1600 / Math.max(base.width, base.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return canvasToAttachment(canvas, name);
  } finally {
    page.cleanup();
  }
}
