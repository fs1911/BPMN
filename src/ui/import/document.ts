import { htmlToMarkdown } from "@core/convert/html-to-markdown";
import { pdfToMarkdown, type PdfPage } from "@core/convert/pdf-to-markdown";

/**
 * Word / PDF file → Markdown, entirely in the browser. The file itself never
 * leaves the machine; only the Markdown the user reviewed in the text field
 * is sent to the AI. The converter libraries are loaded on first use so the
 * editor itself stays small.
 */

export interface ImportedDocument {
  markdown: string;
  /** user-facing notes (scan detected, images ignored, …) */
  warnings: string[];
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function documentToMarkdown(file: File): Promise<ImportedDocument> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`Datei zu gross (${Math.round(file.size / 1024 / 1024)} MB, maximal 25 MB).`);
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) return docx(file);
  if (name.endsWith(".pdf")) return pdf(file);
  if (name.endsWith(".doc")) throw new Error("Alte Word-Dateien (.doc) werden nicht unterstützt – bitte in Word als .docx speichern.");
  throw new Error("Nur Word (.docx) und PDF werden unterstützt.");
}

async function docx(file: File): Promise<ImportedDocument> {
  const mammoth = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    // Images would only cost tokens without helping the model.
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  const markdown = htmlToMarkdown(html);
  const warnings: string[] = [];
  if (/<img/i.test(html)) warnings.push("Bilder und eingebettete Grafiken wurden ignoriert – nur der Text wird verwendet.");
  if (!markdown.trim()) warnings.push("Im Dokument wurde kein Text gefunden.");
  return { markdown, warnings };
}

async function pdf(file: File): Promise<ImportedDocument> {
  // Legacy build: the modern one relies on brand-new JS (Math.sumPrecise) and
  // silently returns truncated text in browsers that lack it.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: PdfPage[] = [];
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
  } finally {
    void doc.destroy();
  }
  const result = pdfToMarkdown(pages);
  const warnings: string[] = [];
  if (result.diagramPages.length) {
    const list = result.diagramPages.join(", ");
    warnings.push(`Seite ${list} sieht nach einer Grafik/einem Diagramm aus und wurde weggelassen – deren Beschriftungen ergeben ohne Pfeile keinen lesbaren Text.`);
  }
  if (result.scanned) {
    warnings.push("Das PDF enthält (fast) keinen Text – vermutlich ein Scan oder ein exportiertes Bild. Bitte die Word-Vorlage verwenden oder den Text abtippen.");
  }
  return { markdown: result.markdown, warnings };
}
