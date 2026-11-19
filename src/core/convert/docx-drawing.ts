/**
 * Flowcharts drawn in Word (shapes and arrows) → their flow.
 *
 * Text extraction keeps only the words in the boxes, in no particular order,
 * and drops the arrows — the AI then has to guess the process. Word stores
 * each arrow as a connector shape: glued connectors name the shapes they join
 * (a:stCxn / a:endCxn); loose ones are matched to the shape at their ends by
 * position. Short texts next to an arrow ("Ja", "Nein") become its label.
 * Only DrawingML (wps:wsp) is read; the VML copy Word adds for old versions
 * is the same drawing.
 */

export type DrawingShapeKind = "start-end" | "decision" | "step" | "text";

export interface DrawingShape {
  id: string;
  kind: DrawingShapeKind;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DrawingFlow {
  from: string;
  to: string;
  label?: string;
}

export interface FlowDrawing {
  shapes: DrawingShape[];
  flows: DrawingFlow[];
  /** texts in the drawing that belong to no arrow (notes, headings) */
  notes: string[];
}

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
};

const CONNECTOR = /connector/i;
const DECISION = new Set(["flowChartDecision", "diamond"]);
const TERMINATOR = new Set(["flowChartTerminator", "ellipse", "flowChartConnector", "roundRect"]);
/** EMU: 1 mm = 36 000 */
const SNAP = 150_000;
const LABEL_REACH = 300_000;

interface Connector {
  id: string;
  start: [number, number];
  end: [number, number];
  /** glued shape ids, if Word glued the ends */
  from?: string;
  to?: string;
  bent: boolean;
}

/**
 * All drawings of a document.xml that contain arrows. One w:drawing (a group
 * or a canvas) is one drawing; loose shapes on the page form one more.
 */
export function readFlowDrawings(documentXml: string, parser: DOMParser = new DOMParser()): FlowDrawing[] {
  const doc = parser.parseFromString(documentXml, "application/xml");
  const result: FlowDrawing[] = [];
  const loose: Element[] = [];
  for (const drawing of Array.from(doc.getElementsByTagNameNS(NS.w, "drawing"))) {
    const shapes = Array.from(drawing.getElementsByTagNameNS(NS.wps, "wsp"));
    if (!shapes.length) continue;
    // a group or a drawing canvas: its shapes share one coordinate system
    const grouped = Array.from(drawing.getElementsByTagName("*")).some((el) => el.localName === "wgp" || el.localName === "wpc");
    if (grouped) {
      const d = readDrawing(shapes, () => [0, 0]);
      if (d) result.push(d);
    } else loose.push(...shapes);
  }
  // Loose floating shapes: positioned on the page by their anchor.
  if (loose.length) {
    const d = readDrawing(loose, (sp) => anchorOffset(sp));
    if (d) result.push(d);
  }
  return result;
}

function anchorOffset(sp: Element): [number, number] {
  let el: Element | null = sp;
  while (el && !(el.namespaceURI === NS.wp && el.localName === "anchor")) el = el.parentElement;
  if (!el) return [0, 0];
  const pos = (axis: "positionH" | "positionV") => Number(el!.getElementsByTagNameNS(NS.wp, axis)[0]?.getElementsByTagNameNS(NS.wp, "posOffset")[0]?.textContent ?? 0);
  return [pos("positionH"), pos("positionV")];
}

function readDrawing(elements: Element[], offset: (sp: Element) => [number, number]): FlowDrawing | undefined {
  const shapes: DrawingShape[] = [];
  const connectors: Connector[] = [];
  for (const sp of elements) {
    const id = sp.getElementsByTagNameNS(NS.wps, "cNvPr")[0]?.getAttribute("id") ?? `s${shapes.length + connectors.length}`;
    const xfrm = sp.getElementsByTagNameNS(NS.a, "xfrm")[0];
    const off = xfrm?.getElementsByTagNameNS(NS.a, "off")[0];
    const ext = xfrm?.getElementsByTagNameNS(NS.a, "ext")[0];
    if (!off || !ext) continue;
    const [dx, dy] = offset(sp);
    const x = Number(off.getAttribute("x")) + dx;
    const y = Number(off.getAttribute("y")) + dy;
    const w = Number(ext.getAttribute("cx"));
    const h = Number(ext.getAttribute("cy"));
    const prst = sp.getElementsByTagNameNS(NS.a, "prstGeom")[0]?.getAttribute("prst") ?? "";
    const isConnector = sp.getElementsByTagNameNS(NS.wps, "cNvCnPr").length > 0 || CONNECTOR.test(prst) || prst === "line";
    if (isConnector) {
      const flipH = xfrm!.getAttribute("flipH") === "1";
      const flipV = xfrm!.getAttribute("flipV") === "1";
      const glued = (tag: string) => {
        const v = sp.getElementsByTagNameNS(NS.a, tag)[0]?.getAttribute("id");
        return v && v !== "4294967295" ? v : undefined;
      };
      connectors.push({
        id,
        start: [x + (flipH ? w : 0), y + (flipV ? h : 0)],
        end: [x + (flipH ? 0 : w), y + (flipV ? 0 : h)],
        from: glued("stCxn"),
        to: glued("endCxn"),
        bent: /bent|curved/i.test(prst),
      });
      continue;
    }
    const text = Array.from(sp.getElementsByTagNameNS(NS.w, "p"))
      .map((p) => Array.from(p.getElementsByTagNameNS(NS.w, "t")).map((t) => t.textContent ?? "").join(""))
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    const kind: DrawingShapeKind = DECISION.has(prst) ? "decision" : TERMINATOR.has(prst) && /^(start|ende?|end|stop|beginn)\b/i.test(text) ? "start-end" : prst === "textNoShape" || !prst ? "text" : "step";
    shapes.push({ id, kind, text, x, y, w, h });
  }
  if (!connectors.length) return undefined;

  const byId = new Map(shapes.map((s) => [s.id, s]));
  const boxes = shapes.filter((s) => s.kind !== "text" || s.text.length > 25);
  const nearestShape = (p: [number, number]) => {
    let best: { s: DrawingShape; d: number } | undefined;
    for (const s of boxes) {
      const d = rectDistance(p, s);
      if (d <= SNAP && (!best || d < best.d)) best = { s, d };
    }
    return best?.s;
  };

  const flows: (DrawingFlow & { c: Connector })[] = [];
  for (const c of connectors) {
    const from = (c.from && byId.get(c.from)) || nearestShape(c.start);
    const to = (c.to && byId.get(c.to)) || nearestShape(c.end);
    if (!from || !to || from === to) continue;
    flows.push({ from: from.id, to: to.id, c });
  }

  // Labels: short texts in plain boxes that no arrow touches, next to an arrow
  // (the nearest one; arrows out of a decision first).
  const connected = new Set(flows.flatMap((f) => [f.from, f.to]));
  const notes: string[] = [];
  for (const s of shapes) {
    if (connected.has(s.id) || !s.text) continue;
    const short = s.text.length <= 25 && s.kind !== "decision";
    const center: [number, number] = [s.x + s.w / 2, s.y + s.h / 2];
    const ranked = short
      ? flows
          .map((f) => ({ f, d: segmentsDistance(center, f.c), decision: byId.get(f.from)?.kind === "decision" }))
          .filter((r) => r.d <= LABEL_REACH && !r.f.label)
          .sort((p, q) => Number(q.decision) - Number(p.decision) || p.d - q.d)
      : [];
    if (ranked.length) ranked[0].f.label = s.text;
    else notes.push(s.text);
  }

  const used = new Set(flows.flatMap((f) => [f.from, f.to]));
  return {
    shapes: shapes.filter((s) => used.has(s.id)).sort((p, q) => p.y - q.y || p.x - q.x),
    flows: flows.map(({ from, to, label }) => (label ? { from, to, label } : { from, to })),
    notes,
  };
}

function rectDistance([px, py]: [number, number], s: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(s.x - px, 0, px - (s.x + s.w));
  const dy = Math.max(s.y - py, 0, py - (s.y + s.h));
  return Math.hypot(dx, dy);
}

/** Distance from a point to the arrow's path (an L for bent connectors: either corner). */
function segmentsDistance(p: [number, number], c: Connector): number {
  const seg = (a: [number, number], b: [number, number]) => {
    const [ax, ay] = a;
    const [bx, by] = b;
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / l2)) : 0;
    return Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay)));
  };
  if (!c.bent) return seg(c.start, c.end);
  const corners: [number, number][] = [
    [c.end[0], c.start[1]],
    [c.start[0], c.end[1]],
  ];
  return Math.min(...corners.map((k) => Math.min(seg(c.start, k), seg(k, c.end))));
}

/**
 * The drawings as a text section for the AI: every shape with a short id, and
 * every arrow with its label — the flow is stated, nothing left to guess.
 */
export function drawingsToMarkdown(drawings: FlowDrawing[]): string {
  return drawings
    .map((d, i) => {
      const ids = new Map(d.shapes.map((s, k) => [s.id, `${drawings.length > 1 ? `Z${i + 1}.` : ""}${k + 1}`]));
      const kindText: Record<DrawingShapeKind, string> = { "start-end": " (Start/Ende)", decision: " (Entscheidung)", step: "", text: "" };
      const lines = [
        `## Ablaufzeichnung ${i + 1} aus dem Word-Dokument (Formen und Pfeile ausgewertet)`,
        "",
        "Formen:",
        ...d.shapes.map((s) => `- [${ids.get(s.id)}] ${s.text || "(ohne Text)"}${kindText[s.kind]}`),
        "",
        "Pfeile:",
        ...d.flows.map((f) => `- ${ids.get(f.from)} → ${ids.get(f.to)}${f.label ? ` [${f.label}]` : ""}`),
      ];
      if (d.notes.length) lines.push("", "Weitere Texte in der Zeichnung:", ...d.notes.map((n) => `- ${n}`));
      return lines.join("\n");
    })
    .join("\n\n");
}
