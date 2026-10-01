/**
 * HTML (as produced by mammoth from a Word file) → compact Markdown.
 *
 * Keeps what helps the model understand a procedure — headings, numbered and
 * bulleted steps, tables (roles/responsibilities) and emphasis — and drops
 * everything else (images, links targets, styling, tables of contents).
 */
export function htmlToMarkdown(html: string, parser: DOMParser = new DOMParser()): string {
  const doc = parser.parseFromString(html, "text/html");
  const out: string[] = [];
  for (const node of Array.from(doc.body.childNodes)) block(node, out, 0);
  return tidyMarkdown(out.join("\n"));
}

function block(node: Node, out: string[], depth: number): void {
  if (node.nodeType === 3) {
    const t = clean(node.textContent ?? "");
    if (t) out.push(t, "");
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const h = /^h([1-6])$/.exec(tag);
  if (h) {
    const t = inline(el);
    if (t) out.push(`${"#".repeat(Number(h[1]))} ${t}`, "");
    return;
  }
  if (tag === "ul" || tag === "ol") {
    let n = 1;
    for (const li of Array.from(el.children)) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const own = inline(li, true);
      const marker = tag === "ol" ? `${n++}.` : "-";
      if (own) out.push(`${"  ".repeat(depth)}${marker} ${own}`);
      for (const sub of Array.from(li.children)) {
        const st = sub.tagName.toLowerCase();
        if (st === "ul" || st === "ol") block(sub, out, depth + 1);
      }
    }
    if (depth === 0) out.push("");
    return;
  }
  if (tag === "table") {
    const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children).map((td) => inline(td).replace(/\|/g, "/") || " "),
    );
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!width) return;
    rows.forEach((r, i) => {
      while (r.length < width) r.push(" ");
      out.push(`| ${r.join(" | ")} |`);
      if (i === 0) out.push(`|${" --- |".repeat(width)}`);
    });
    out.push("");
    return;
  }
  if (tag === "p" || tag === "li" || tag === "blockquote" || tag === "pre") {
    const t = inline(el);
    if (t) out.push(t, "");
    return;
  }
  if (tag === "img" || tag === "style" || tag === "script") return;
  // div, section, … → descend
  for (const child of Array.from(el.childNodes)) block(child, out, depth);
}

/** Text of an element with bold/italic as Markdown; nested lists are left to `block`. */
function inline(el: Element, skipLists = false): string {
  let s = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      s += node.textContent ?? "";
      continue;
    }
    if (node.nodeType !== 1) continue;
    const c = node as Element;
    const tag = c.tagName.toLowerCase();
    if (skipLists && (tag === "ul" || tag === "ol")) continue;
    if (tag === "img") continue;
    if (tag === "br") {
      s += " ";
      continue;
    }
    const t = inline(c, skipLists);
    if (!t.trim()) {
      s += t;
      continue;
    }
    if (tag === "strong" || tag === "b") s += `**${t.trim()}** `;
    else if (tag === "em" || tag === "i") s += `*${t.trim()}* `;
    else s += t + (tag === "p" ? " " : "");
  }
  return clean(s);
}

const clean = (s: string) => s.replace(/[ \s]+/g, " ").trim();

/**
 * Final clean-up shared by all converters: drop table-of-contents lines and
 * empty emphasis, collapse blank lines.
 */
export function tidyMarkdown(md: string): string {
  return md
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => !/(\.{4,}|…{2,}|\t)\s*\d+$/.test(l)) // "3.2 Ablauf ........ 7"
    .map((l) => l.replace(/\*\*\s*\*\*/g, "").replace(/(^|\s)\*\s*\*(\s|$)/g, "$1$2"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
