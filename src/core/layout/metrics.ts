import { BpmnModel, Bounds, Point } from "../model";
import { countLabelCollisions } from "./labels";

/**
 * Objective layout quality metrics for a laid-out, routed diagram.
 *
 * Used by tests and the benchmark (`npm run bench:layout`) so layout/routing
 * changes are judged by numbers, not by eyeballing a single example.
 */
export interface LayoutMetrics {
  /** proper crossings between sequence flows of different edges. */
  crossings: number;
  /** collinear stretches shared by two different edges (overlapping lines). */
  overlaps: number;
  /**
   * shared stretches that start at a common source port or end at a common
   * target port — flows bundled into/out of one gateway corner (standard BPMN
   * notation, reported separately from real overlaps).
   */
  bundles: number;
  /** segments passing through a shape that is neither source nor target. */
  shapeHits: number;
  /** waypoints outside the pool (when there is one). */
  outsidePool: number;
  /** overlapping flow-node shapes. */
  nodeOverlaps: number;
  /** total number of bends. */
  bends: number;
  /** total routed length (px). */
  length: number;
  /**
   * Excess length over the shortest orthogonal connection (px, summed):
   * long detours around the diagram show up here.
   */
  detour: number;
  /** the single worst detour (px). */
  maxDetour: number;
  /** non-orthogonal (diagonal) segments. */
  diagonals: number;
  /** labels overlapping shapes, other labels or foreign flows. */
  labelCollisions: number;
}

interface Seg {
  edge: string;
  a: Point;
  b: Point;
}

const EPS = 0.5;

export function measureLayout(model: BpmnModel, scope = model.rootProcessId): LayoutMetrics {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope && n.type !== "boundaryEvent");
  const inScope = (id: string) => model.nodes[id]?.parent === scope || !!model.participants[id];
  const edges = Object.values(model.edges).filter(
    (e) =>
      e.waypoints &&
      e.waypoints.length >= 2 &&
      ((e.type === "sequenceFlow" && model.nodes[e.source]?.parent === scope) ||
        (e.type === "messageFlow" && (inScope(e.source) || inScope(e.target)))),
  );

  const segs: Seg[] = [];
  let bends = 0;
  let length = 0;
  let detour = 0;
  let maxDetour = 0;
  let diagonals = 0;
  for (const e of edges) {
    const w = e.waypoints!;
    bends += Math.max(0, w.length - 2);
    let own = 0;
    for (let i = 0; i < w.length - 1; i++) own += Math.abs(w[i].x - w[i + 1].x) + Math.abs(w[i].y - w[i + 1].y);
    // a connection needs at least the Manhattan distance plus short stubs when it has to turn back
    const a = w[0];
    const z = w[w.length - 1];
    const minimal = Math.abs(a.x - z.x) + Math.abs(a.y - z.y) + (e.isBackEdge ? 40 : 0);
    const excess = Math.max(0, own - minimal);
    detour += excess;
    maxDetour = Math.max(maxDetour, excess);
    for (let i = 0; i < w.length - 1; i++) {
      const a = w[i];
      const b = w[i + 1];
      length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) diagonals++;
      if (Math.abs(a.x - b.x) > EPS || Math.abs(a.y - b.y) > EPS) segs.push({ edge: e.id, a, b });
    }
  }

  let crossings = 0;
  let overlaps = 0;
  let bundles = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i];
      const t = segs[j];
      if (s.edge === t.edge) continue;
      const hs = isH(s);
      const ht = isH(t);
      if (hs === ht) {
        if (collinearOverlap(s, t, hs) > 2) {
          if (isBundle(model, s, t)) bundles++;
          else overlaps++;
        }
      } else if (properCross(hs ? s : t, hs ? t : s)) {
        crossings++;
      }
    }
  }

  let shapeHits = 0;
  for (const s of segs) {
    const e = model.edges[s.edge];
    for (const n of nodes) {
      if (n.id === e.source || n.id === e.target) continue;
      if (segmentHitsRect(s.a, s.b, shrink(n.bounds, 2))) shapeHits++;
    }
  }

  let outsidePool = 0;
  const pool = Object.values(model.participants).find((p) => p.processRef === scope);
  if (pool) {
    const r = pool.bounds;
    for (const e of edges) {
      if (e.type === "messageFlow") continue; // they connect pools by definition
      for (const p of e.waypoints!) {
        if (p.x < r.x - EPS || p.x > r.x + r.width + EPS || p.y < r.y - EPS || p.y > r.y + r.height + EPS) outsidePool++;
      }
    }
  }

  let nodeOverlaps = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (rectsOverlap(nodes[i].bounds, nodes[j].bounds)) nodeOverlaps++;
    }
  }

  return {
    crossings,
    overlaps,
    bundles,
    shapeHits,
    outsidePool,
    nodeOverlaps,
    bends,
    length: Math.round(length),
    detour: Math.round(detour),
    maxDetour: Math.round(maxDetour),
    diagonals,
    labelCollisions: countLabelCollisions(model, scope),
  };
}

/** Both segments touch the same port of a shared source or target. */
function isBundle(model: BpmnModel, s: Seg, t: Seg): boolean {
  const es = model.edges[s.edge];
  const et = model.edges[t.edge];
  const ws = es.waypoints!;
  const wt = et.waypoints!;
  const touches = (seg: Seg, p: Point) => (samePt(seg.a, p) || samePt(seg.b, p));
  if (es.source === et.source && samePt(ws[0], wt[0]) && touches(s, ws[0]) && touches(t, wt[0])) return true;
  const ls = ws[ws.length - 1];
  const lt = wt[wt.length - 1];
  return es.target === et.target && samePt(ls, lt) && touches(s, ls) && touches(t, lt);
}
const samePt = (a: Point, b: Point) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

const isH = (s: Seg) => Math.abs(s.a.y - s.b.y) <= EPS;

function collinearOverlap(s: Seg, t: Seg, horizontal: boolean): number {
  if (horizontal) {
    if (Math.abs(s.a.y - t.a.y) > EPS) return 0;
    const [s0, s1] = [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)];
    const [t0, t1] = [Math.min(t.a.x, t.b.x), Math.max(t.a.x, t.b.x)];
    return Math.min(s1, t1) - Math.max(s0, t0);
  }
  if (Math.abs(s.a.x - t.a.x) > EPS) return 0;
  const [s0, s1] = [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)];
  const [t0, t1] = [Math.min(t.a.y, t.b.y), Math.max(t.a.y, t.b.y)];
  return Math.min(s1, t1) - Math.max(s0, t0);
}

/** Horizontal h and vertical v cross strictly inside both segments. */
function properCross(h: Seg, v: Seg): boolean {
  const y = h.a.y;
  const x = v.a.x;
  const [h0, h1] = [Math.min(h.a.x, h.b.x), Math.max(h.a.x, h.b.x)];
  const [v0, v1] = [Math.min(v.a.y, v.b.y), Math.max(v.a.y, v.b.y)];
  return x > h0 + EPS && x < h1 - EPS && y > v0 + EPS && y < v1 - EPS;
}

function shrink(b: Bounds, d: number): Bounds {
  return { x: b.x + d, y: b.y + d, width: Math.max(0, b.width - 2 * d), height: Math.max(0, b.height - 2 * d) };
}

function segmentHitsRect(a: Point, b: Point, r: Bounds): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return x1 > r.x && x0 < r.x + r.width && y1 > r.y && y0 < r.y + r.height;
}

function rectsOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
