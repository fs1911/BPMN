import { tidyMarkdown } from "./html-to-markdown";

/**
 * Positioned text from a PDF page (pdf.js text content) → Markdown.
 *
 * PDFs have no paragraphs, only glyph runs at coordinates. This rebuilds
 * lines (same baseline), paragraphs (small line gaps), headings (larger font
 * than the body text), list items (bullet / number at line start) and drops
 * running headers, footers and page numbers that repeat on every page.
 */

export interface PdfTextItem {
  str: string;
  x: number;
  /** baseline, PDF coordinates (origin bottom left, grows upwards) */
  y: number;
  width: number;
  /** font size */
  size: number;
}

export interface PdfPage {
  items: PdfTextItem[];
  height: number;
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  page: number;
}

export interface PdfConversion {
  markdown: string;
  /** probably a scan: (almost) no text layer */
  scanned: boolean;
  pages: number;
  /** 1-based numbers of pages left out because they look like a diagram */
  diagramPages: number[];
}

export function pdfToMarkdown(pages: PdfPage[]): PdfConversion {
  const all = pages.flatMap((p, i) => buildLines(p.items, i));
  const chars = all.reduce((n, l) => n + l.text.length, 0);
  const scanned = pages.length > 0 && chars < 40 * pages.length;
  const diagram = new Set(pages.flatMap((p, i) => (isDiagramPage(p) ? [i] : [])));
  // Labels of a drawn diagram (e.g. an exported process map) come out as word
  // salad without the arrows: noise for the model, so leave such pages out.
  const lines = all.filter((l) => !diagram.has(l.page));

  const body = bodySize(lines);
  const kept = dropRunningLines(lines, pages);
  const levels = headingLevels(kept, body);
  const out: string[] = [];
  let para = "";
  let prev: Line | undefined;
  const flush = () => {
    if (para) out.push(para, "");
    para = "";
  };

  for (const l of kept) {
    const heading = headingLevel(l, levels);
    const item = listItem(l.text);
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    const prevHeading = prev ? headingLevel(prev, levels) : 0;
    const newBlock = heading > 0 || item !== undefined || gap > Math.max(prev?.size ?? 0, l.size) * 1.8 || prevHeading > 0;
    const row = l.text.includes(" | ");

    if (heading > 0 && heading === prevHeading && gap <= l.size * 1.6) {
      // A title wrapped over several lines stays one heading.
      out[out.length - 2] += ` ${l.text}`;
    } else if (heading > 0) {
      flush();
      out.push(`${"#".repeat(heading)} ${l.text}`, "");
    } else if (row) {
      // Table row: own line, rows of one table stay together.
      flush();
      const continues = prev?.text.includes(" | ") && out[out.length - 1] === "";
      if (continues) out.pop();
      out.push(`| ${l.text} |`);
      if (!continues) out.push(`|${" --- |".repeat(l.text.split(" | ").length)}`);
      out.push("");
    } else if (item !== undefined) {
      flush();
      para = item;
    } else if (newBlock || !para) {
      flush();
      para = l.text;
    } else {
      para = joinLines(para, l.text);
    }
    prev = l;
  }
  flush();
  // List items were flushed as single paragraphs: pull consecutive ones together.
  const md = out.join("\n").replace(/^(- .*|\d+\. .*)\n\n(?=- |\d+\. )/gm, "$1\n");
  return { markdown: tidyMarkdown(md), scanned, pages: pages.length, diagramPages: [...diagram].map((i) => i + 1) };
}

/**
 * Text and table pages reuse a handful of left edges (margin, list indent,
 * table columns); diagram labels are scattered over the page. Measured on
 * real exports: text/table pages ≤ 11 distinct edges, diagrams ≥ 22.
 */
function isDiagramPage(p: PdfPage): boolean {
  const runs = p.items.filter((it) => it.str.trim());
  if (runs.length < 20) return false;
  const edges = new Set(runs.map((r) => Math.round(r.x / 6))).size;
  const words = runs.map((r) => r.str.trim().split(/\s+/).length).sort((a, b) => a - b);
  return edges >= 18 && edges / runs.length >= 0.4 && words[Math.floor(words.length / 2)] <= 2;
}

function buildLines(items: PdfTextItem[], page: number): Line[] {
  const runs = items.filter((it) => it.str.trim() || it.str === " ").sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; runs: PdfTextItem[] }[] = [];
  for (const it of runs) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.size * 0.3));
    if (line) line.runs.push(it);
    else lines.push({ y: it.y, runs: [it] });
  }
  return lines
    .map((l) => {
      const rs = l.runs.sort((a, b) => a.x - b.x);
      let text = "";
      let end = -Infinity;
      let sep = "";
      for (const r of rs) {
        const size = r.size || 10;
        // Generators often fill the space between table cells with one wide
        // space glyph: its width, not the gap after it, marks the column.
        if (!r.str.trim()) {
          if (text) sep = r.width > size * 2 ? " | " : sep || " ";
          end = Math.max(end, r.x + r.width);
          continue;
        }
        const gap = r.x - end;
        if (text) {
          if (sep === " | " || gap > size * 3) text += " | ";
          else if ((sep || gap > size * 0.15) && !text.endsWith(" ") && !r.str.startsWith(" ")) text += " ";
        }
        sep = "";
        text += r.str;
        end = r.x + r.width;
      }
      const size = rs.reduce((m, r) => Math.max(m, r.size), 0);
      return { text: text.replace(/\s+/g, " ").trim(), x: rs[0].x, y: l.y, size, page };
    })
    .filter((l) => l.text);
}

/** Most common font size, weighted by characters. */
function bodySize(lines: Line[]): number {
  const w = new Map<number, number>();
  for (const l of lines) w.set(Math.round(l.size), (w.get(Math.round(l.size)) ?? 0) + l.text.length);
  let best = 10;
  let n = -1;
  for (const [s, c] of w) if (c > n) [best, n] = [s, c];
  return best;
}

/** Heading sizes ranked: the largest becomes "#", the next "##", then "###". */
function headingLevels(lines: Line[], body: number): Map<number, number> {
  const sizes = [...new Set(lines.filter((l) => l.size >= body * 1.12).map((l) => Math.round(l.size)))].sort((a, b) => b - a);
  return new Map(sizes.map((s, i) => [s, Math.min(3, i + 1)]));
}

function headingLevel(l: Line, levels: Map<number, number>): number {
  if (l.text.length > 120 || /[.,;:]$/.test(l.text) || listItem(l.text) !== undefined) return 0;
  return levels.get(Math.round(l.size)) ?? 0;
}

/** Normalised "- text" / "1. text" for list lines, else undefined. */
function listItem(text: string): string | undefined {
  const bullet = /^[•·▪■◦●○‣–\-*]\s+(.+)$/.exec(text);
  if (bullet) return `- ${bullet[1]}`;
  // "1. Text", also "1.Text" when the generator dropped the space; not "3.2 …"
  const num = /^(\d{1,2})[.)]\s*([A-Za-zÄÖÜäöü].*)$/.exec(text);
  if (num) return `${num[1]}. ${num[2]}`;
  return undefined;
}

function joinLines(a: string, b: string): string {
  // Hyphenation at line end: "Freigabe-" + "prozess" → "Freigabeprozess",
  // but keep "Einkaufs- und Lagerprozess".
  if (/[a-zäöüß]-$/.test(a) && /^[a-zäöüß]/.test(b) && !/^(und|oder|bzw)\b/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

/** Headers/footers: same text (digits ignored) near the top/bottom of most pages. */
function dropRunningLines(lines: Line[], pages: PdfPage[]): Line[] {
  const key = (l: Line) => l.text.replace(/\d+/g, "#").toLowerCase();
  const edge = (l: Line) => {
    const h = pages[l.page]?.height ?? 842;
    return l.y > h * 0.9 || l.y < h * 0.1;
  };
  const count = new Map<string, Set<number>>();
  for (const l of lines) if (edge(l)) (count.get(key(l)) ?? count.set(key(l), new Set()).get(key(l))!).add(l.page);
  const minPages = Math.max(2, Math.ceil(pages.length * 0.5));
  return lines.filter((l) => {
    if (/^(seite\s*)?\d+(\s*(von|\/)\s*\d+)?$/i.test(l.text)) return false;
    if (!edge(l)) return true;
    return pages.length < 2 || (count.get(key(l))?.size ?? 0) < minPages;
  });
}
