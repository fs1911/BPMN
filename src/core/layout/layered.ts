import {
  Adjacency,
  BpmnModel,
  Edge,
  FlowNode,
  Point,
  buildAdjacency,
  detectBackEdges,
  topoOrder,
} from "../model";

/**
 * Layered (Sugiyama) left-to-right layout with integrated orthogonal routing,
 * tuned for BPMN.
 *
 * Pipeline:
 *  1. Ranks by longest path over forward edges (back edges removed), so loops
 *     never drag their target into a later column.
 *  2. Long edges get one *dummy* per rank they skip. Dummies reserve a slot in
 *     every column the edge passes, so long flows never run through shapes and
 *     take part in crossing reduction like real nodes.
 *  3. Crossing reduction (weighted median sweeps + transpose), constrained to
 *     keep every node inside its swimlane.
 *  4. Y assignment inside lane bands (median pulls, overlap resolution,
 *     chain straightening → straight main flow and straight long edges).
 *  5. Port assignment: activities use left/right sides (fanned when shared);
 *     gateways and events use their real corners — a split sends its outer
 *     branches out of the top/bottom corner, a join takes them in the same way.
 *  6. Every vertical segment between two columns gets its own track in that
 *     corridor; tracks are ordered to minimise crossings and the corridor is
 *     widened to fit them. No two flows share a track.
 *
 * Forward flows are routed here exactly; back edges (loops) are left to the
 * A* router, which routes them around everything already placed.
 */

export interface LayoutOptions {
  /** minimum horizontal gap between rank columns (grows with the number of tracks). */
  rankSep: number;
  /** vertical gap between nodes within a column. */
  nodeSep: number;
  /** number of crossing-reduction sweeps. */
  sweeps: number;
  /** left/top margin inside the scope. */
  marginX: number;
  marginY: number;
  /** which lane a long cross-lane flow runs in: its source's or its target's. */
  longEdgeLane: "source" | "target";
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  rankSep: 64,
  nodeSep: 50,
  sweeps: 12,
  marginX: 60,
  marginY: 60,
  longEdgeLane: "source",
};

export interface LayoutResult {
  scope: string;
  rankOf: Record<string, number>;
  orderInRank: Record<string, number>;
  backEdgeIds: Set<string>;
  /** edges whose waypoints were produced by the layout (forward flows). */
  routed: Set<string>;
}

/** Spacing constants. */
const DUMMY_H = 8;
const DUMMY_SEP = 22;
const LANE_PAD = 26;
const LOOP_CHANNEL = 30;
const TRACK_GAP = 16;
const POOL_GUTTER = 30;
const LANE_INSET = 56; // horizontal room between lane border and first/last column
const NO_LANE = "__nolane__";

interface Item {
  id: string;
  dummy: boolean;
  lane: string;
  rank: number;
  w: number;
  h: number;
  y: number; // center
}

interface Layered {
  items: Record<string, Item>;
  ranks: string[][];
  adj: Adjacency;
  /** original edge id → [source, dummies…, target] */
  chains: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Ranking

function assignRanks(order: string[], adj: Adjacency, backEdges: Set<string>): Record<string, number> {
  const rank: Record<string, number> = {};
  for (const id of order) rank[id] = 0;
  for (const id of order) {
    for (const e of adj.incoming[id] ?? []) {
      if (backEdges.has(e.id)) continue;
      rank[id] = Math.max(rank[id], (rank[e.source] ?? 0) + 1);
    }
  }
  return rank;
}

function buildLayered(
  model: BpmnModel,
  nodeIds: string[],
  adj: Adjacency,
  backEdges: Set<string>,
  rank: Record<string, number>,
  laneOf: (id: string) => string,
  longEdgeLane: "source" | "target",
): Layered {
  const items: Record<string, Item> = {};
  for (const id of nodeIds) {
    const b = model.nodes[id].bounds;
    items[id] = { id, dummy: false, lane: laneOf(id), rank: rank[id], w: b.width, h: b.height, y: 0 };
  }
  const ladj: Adjacency = { outgoing: {}, incoming: {} };
  for (const id of nodeIds) (ladj.outgoing[id] = []), (ladj.incoming[id] = []);
  const link = (id: string, s: string, t: string) => {
    const e = { id, type: "sequenceFlow", source: s, target: t } as Edge;
    ladj.outgoing[s].push(e);
    ladj.incoming[t].push(e);
  };

  const chains: Record<string, string[]> = {};
  for (const id of nodeIds) {
    for (const e of adj.outgoing[id] ?? []) {
      if (backEdges.has(e.id) || !items[e.target]) continue;
      const rs = rank[e.source];
      const rt = rank[e.target];
      const chain = [e.source];
      for (let r = rs + 1; r < rt; r++) {
        const did = `__dummy_${e.id}_${r}`;
        const lane = longEdgeLane === "target" ? items[e.target].lane : items[e.source].lane;
        items[did] = { id: did, dummy: true, lane, rank: r, w: 0, h: DUMMY_H, y: 0 };
        ladj.outgoing[did] = [];
        ladj.incoming[did] = [];
        chain.push(did);
      }
      chain.push(e.target);
      for (let i = 0; i < chain.length - 1; i++) link(`${e.id}#${i}`, chain[i], chain[i + 1]);
      chains[e.id] = chain;
    }
  }

  return { items, ranks: initialOrder(items, ladj, nodeIds, false), adj: ladj, chains };
}

/** Initial order: DFS from the roots so a branch's nodes start out together. */
function initialOrder(items: Record<string, Item>, ladj: Adjacency, nodeIds: string[], reverse: boolean): string[][] {
  const maxRank = Math.max(0, ...Object.values(items).map((it) => it.rank));
  const ranks: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ranks[items[id].rank].push(id);
    const outs = [...(ladj.outgoing[id] ?? [])];
    if (reverse) outs.reverse();
    for (const e of outs) visit(e.target);
  };
  const roots = nodeIds.filter((id) => !(ladj.incoming[id] ?? []).length);
  for (const r of roots) visit(r);
  for (const id of Object.keys(items)) visit(id);
  return ranks;
}

/**
 * Crossing reduction is a local search; run it from several starting orders
 * (DFS, reversed DFS, seeded shuffles) and keep the best result.
 */
function orderRanksMultiStart(L: Layered, nodeIds: string[], laneIdx: (id: string) => number, sweeps: number): void {
  const starts: string[][][] = [
    initialOrder(L.items, L.adj, nodeIds, false),
    initialOrder(L.items, L.adj, nodeIds, true),
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 6; k++) {
    starts.push(
      starts[0].map((rk) => {
        const a = [...rk];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      }),
    );
  }
  let best: string[][] | undefined;
  let bestC = Infinity;
  for (const start of starts) {
    L.ranks = start;
    orderRanks(L, laneIdx, sweeps);
    let c = 0;
    for (let r = 0; r < L.ranks.length - 1; r++) c += layerCrossings(L.ranks[r], L.ranks[r + 1], L.adj);
    if (c < bestC) {
      bestC = c;
      best = L.ranks.map((rk) => [...rk]);
    }
    if (bestC === 0) break;
  }
  L.ranks = best!;
}

// ---------------------------------------------------------------------------
// Crossing reduction (lane-constrained)

function orderRanks(L: Layered, laneIdx: (id: string) => number, sweeps: number): void {
  const pos: Record<string, number> = {};
  const reindex = () => L.ranks.forEach((rk) => rk.forEach((id, i) => (pos[id] = i)));
  for (const rk of L.ranks) rk.sort((a, b) => laneIdx(a) - laneIdx(b));
  reindex();

  const median = (id: string, dir: "in" | "out"): number => {
    const es = (dir === "in" ? L.adj.incoming[id] : L.adj.outgoing[id]) ?? [];
    const ps = es.map((e) => pos[dir === "in" ? e.source : e.target]).sort((a, b) => a - b);
    if (!ps.length) return -1;
    const m = ps.length >> 1;
    return ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2;
  };

  const totalCrossings = () => {
    let c = 0;
    for (let r = 0; r < L.ranks.length - 1; r++) c += layerCrossings(L.ranks[r], L.ranks[r + 1], L.adj);
    return c;
  };

  let best = L.ranks.map((rk) => [...rk]);
  let bestC = totalCrossings();
  for (let s = 0; s < sweeps; s++) {
    const down = s % 2 === 0;
    const seq = down ? [...L.ranks.keys()].slice(1) : [...L.ranks.keys()].reverse().slice(1);
    for (const r of seq) {
      const keyed = L.ranks[r].map((id) => {
        const m = median(id, down ? "in" : "out");
        return { id, key: laneIdx(id) * 1e6 + (m >= 0 ? m : pos[id]) };
      });
      keyed.sort((a, b) => a.key - b.key);
      L.ranks[r] = keyed.map((k) => k.id);
      L.ranks[r].forEach((id, i) => (pos[id] = i));
    }
    transpose(L, laneIdx);
    reindex();
    const c = totalCrossings();
    if (c < bestC) {
      bestC = c;
      best = L.ranks.map((rk) => [...rk]);
    }
  }
  L.ranks = best;
}

/** Swap adjacent same-lane items while that reduces crossings. */
function transpose(L: Layered, laneIdx: (id: string) => number): void {
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let r = 0; r < L.ranks.length; r++) {
      const rank = L.ranks[r];
      for (let i = 0; i < rank.length - 1; i++) {
        if (laneIdx(rank[i]) !== laneIdx(rank[i + 1])) continue;
        const local = () =>
          (r > 0 ? layerCrossings(L.ranks[r - 1], rank, L.adj) : 0) +
          (r < L.ranks.length - 1 ? layerCrossings(rank, L.ranks[r + 1], L.adj) : 0);
        const before = local();
        [rank[i], rank[i + 1]] = [rank[i + 1], rank[i]];
        if (local() < before) improved = true;
        else [rank[i], rank[i + 1]] = [rank[i + 1], rank[i]];
      }
    }
    if (!improved) break;
  }
}

/** Crossings between the edges of two adjacent layers. */
function layerCrossings(upper: string[], lower: string[], adj: Adjacency): number {
  const posU: Record<string, number> = {};
  upper.forEach((id, i) => (posU[id] = i));
  const seq: number[] = [];
  for (const v of lower) {
    const ups = (adj.incoming[v] ?? [])
      .map((e) => posU[e.source])
      .filter((p) => p !== undefined)
      .sort((a, b) => a - b);
    seq.push(...ups);
  }
  let c = 0;
  for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) if (seq[i] > seq[j]) c++;
  return c;
}

// ---------------------------------------------------------------------------
// Y assignment

interface Bands {
  laneTop: Record<string, number>;
  laneHeight: Record<string, number>;
  /** vertical range available for nodes (excludes padding + loop reserve). */
  area: Record<string, [number, number]>;
}

const sep = (a: Item, b: Item, nodeSep: number) => (a.dummy || b.dummy ? DUMMY_SEP : nodeSep);

function stackHeight(list: Item[], nodeSep: number): number {
  let h = 0;
  list.forEach((it, i) => (h += it.h + (i ? sep(list[i - 1], it, nodeSep) : 0)));
  return h;
}

function assignY(L: Layered, lanes: string[], loopsPerLane: Record<string, number>, opts: LayoutOptions): Bands {
  const groups = (r: number, lane: string) => L.ranks[r].map((id) => L.items[id]).filter((it) => it.lane === lane);

  const laneTop: Record<string, number> = {};
  const laneHeight: Record<string, number> = {};
  const area: Record<string, [number, number]> = {};
  let cy = opts.marginY;
  for (const lane of lanes) {
    let content = 70;
    for (let r = 0; r < L.ranks.length; r++) content = Math.max(content, stackHeight(groups(r, lane), opts.nodeSep));
    const reserve = loopsPerLane[lane] ? loopsPerLane[lane] * LOOP_CHANNEL + 8 : 0;
    laneTop[lane] = cy;
    laneHeight[lane] = content + 2 * LANE_PAD + reserve;
    area[lane] = [cy + LANE_PAD, cy + LANE_PAD + content];
    cy += laneHeight[lane];
  }

  // Initial: each (rank, lane) group centred in its lane's area.
  for (let r = 0; r < L.ranks.length; r++) {
    for (const lane of lanes) {
      const g = groups(r, lane);
      const [lo, hi] = area[lane];
      let y = (lo + hi) / 2 - stackHeight(g, opts.nodeSep) / 2;
      g.forEach((it, i) => {
        if (i) y += sep(g[i - 1], it, opts.nodeSep);
        it.y = y + it.h / 2;
        y += it.h;
      });
    }
  }

  const sameLaneNeighbours = (it: Item) =>
    [...(L.adj.incoming[it.id] ?? []).map((e) => e.source), ...(L.adj.outgoing[it.id] ?? []).map((e) => e.target)]
      .map((id) => L.items[id])
      .filter((n) => n.lane === it.lane);

  for (let iter = 0; iter < 16; iter++) {
    const seq = iter % 2 === 0 ? [...L.ranks.keys()] : [...L.ranks.keys()].reverse();
    for (const r of seq) {
      for (const id of L.ranks[r]) {
        const it = L.items[id];
        const ns = sameLaneNeighbours(it);
        if (ns.length) it.y = median(ns.map((n) => n.y));
      }
      for (const lane of lanes) packGroup(groups(r, lane), area[lane], opts.nodeSep);
    }
  }

  // Straighten: an item with exactly one same-lane predecessor snaps onto its
  // line if the slot is free. Turns the main flow and long edges into straight runs.
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < L.ranks.length; r++) {
      for (const lane of lanes) {
        const g = groups(r, lane);
        g.forEach((it, i) => {
          const ins = (L.adj.incoming[it.id] ?? []).map((e) => L.items[e.source]).filter((p) => p.lane === lane);
          const outs = (L.adj.outgoing[it.id] ?? []).map((e) => L.items[e.target]).filter((p) => p.lane === lane);
          const anchor = ins.length === 1 ? ins[0] : ins.length === 0 && outs.length === 1 ? outs[0] : undefined;
          if (!anchor) return;
          const target = anchor.y;
          const prev = g[i - 1];
          const next = g[i + 1];
          const lo = Math.max(area[lane][0] + it.h / 2, prev ? prev.y + prev.h / 2 + sep(prev, it, opts.nodeSep) + it.h / 2 : -Infinity);
          const hi = Math.min(area[lane][1] - it.h / 2, next ? next.y - next.h / 2 - sep(it, next, opts.nodeSep) - it.h / 2 : Infinity);
          if (target >= lo - 0.5 && target <= hi + 0.5) it.y = target;
        });
      }
    }
  }

  for (const it of Object.values(L.items)) it.y = Math.round(it.y);
  return { laneTop, laneHeight, area };
}

/** Keep a group's order, enforce spacing, and keep it inside [lo, hi]. */
function packGroup(g: Item[], [lo, hi]: [number, number], nodeSep: number): void {
  if (!g.length) return;
  g[0].y = Math.max(g[0].y, lo + g[0].h / 2);
  for (let i = 1; i < g.length; i++) {
    const min = g[i - 1].y + g[i - 1].h / 2 + sep(g[i - 1], g[i], nodeSep) + g[i].h / 2;
    if (g[i].y < min) g[i].y = min;
  }
  const last = g[g.length - 1];
  if (last.y + last.h / 2 > hi) last.y = hi - last.h / 2;
  for (let i = g.length - 2; i >= 0; i--) {
    const max = g[i + 1].y - g[i + 1].h / 2 - sep(g[i], g[i + 1], nodeSep) - g[i].h / 2;
    if (g[i].y > max) g[i].y = max;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// Ports + corridor tracks

type Side = "left" | "right" | "top" | "bottom";
type XRef = { node: string; at: "left" | "right" | "cx" } | { corridor: number; seg: number };
interface RoutePt {
  x: XRef;
  y: number;
}
interface CorridorSeg {
  edge: string;
  y1: number; // y of the horizontal arriving from the left
  y2: number; // y of the horizontal leaving to the right
  x?: number;
}

function kindOf(n: FlowNode): "gateway" | "event" | "activity" {
  if (n.type.endsWith("Gateway")) return "gateway";
  if (n.type.endsWith("Event")) return "event";
  return "activity";
}

function planRoutes(model: BpmnModel, L: Layered) {
  const items = L.items;
  const exits: Record<string, { side: Side; y: number }> = {};
  const entries: Record<string, { side: Side; y: number }> = {};
  const edgeIds = Object.keys(L.chains);

  /** Is the node's own column free between its border and y (for corner routes)? */
  const columnFree = (nodeId: string, y: number): boolean => {
    const it = items[nodeId];
    const top = it.y - it.h / 2;
    const bottom = it.y + it.h / 2;
    const [a, b] = y < it.y ? [y - 10, top] : [bottom, y + 10];
    return L.ranks[it.rank].every((id) => {
      if (id === nodeId) return true;
      const o = items[id];
      return o.y + o.h / 2 + 6 < a || o.y - o.h / 2 - 6 > b;
    });
  };

  const fan = (n: number, i: number) => (n <= 1 ? 0.5 : 0.25 + (0.5 * i) / (n - 1));

  // Exits.
  const outsOf: Record<string, string[]> = {};
  for (const id of edgeIds) (outsOf[L.chains[id][0]] ||= []).push(id);
  for (const [nid, outs] of Object.entries(outsOf)) {
    const it = items[nid];
    const node = model.nodes[nid];
    const nextY = (e: string) => items[L.chains[e][1]].y;
    outs.sort((a, b) => nextY(a) - nextY(b) || a.localeCompare(b));
    if (kindOf(node) === "activity") {
      outs.forEach((e, i) => (exits[e] = { side: "right", y: Math.round(it.y - it.h / 2 + it.h * fan(outs.length, i)) }));
      continue;
    }
    for (const e of outs) exits[e] = { side: "right", y: it.y };
    if (outs.length >= 2) {
      const first = outs[0];
      const last = outs[outs.length - 1];
      if (nextY(first) < it.y - it.h / 2 - 10 && columnFree(nid, nextY(first))) exits[first] = { side: "top", y: nextY(first) };
      if (nextY(last) > it.y + it.h / 2 + 10 && columnFree(nid, nextY(last))) exits[last] = { side: "bottom", y: nextY(last) };
    }
  }

  // Entries.
  const insOf: Record<string, string[]> = {};
  for (const id of edgeIds) (insOf[L.chains[id][L.chains[id].length - 1]] ||= []).push(id);
  const cornerExit = (e: string) => L.chains[e].length === 2 && exits[e].side !== "right";
  const prevY = (e: string) => {
    const c = L.chains[e];
    return c.length > 2 ? items[c[c.length - 2]].y : exits[e].side === "right" ? exits[e].y : items[c[0]].y;
  };
  for (const [nid, ins] of Object.entries(insOf)) {
    const it = items[nid];
    const node = model.nodes[nid];
    ins.sort((a, b) => prevY(a) - prevY(b) || a.localeCompare(b));
    if (kindOf(node) === "activity") {
      ins.forEach((e, i) => (entries[e] = { side: "left", y: Math.round(it.y - it.h / 2 + it.h * fan(ins.length, i)) }));
      continue;
    }
    for (const e of ins) entries[e] = { side: "left", y: it.y };
    if (ins.length >= 2) {
      const first = ins[0];
      const last = ins[ins.length - 1];
      if (!cornerExit(first) && prevY(first) < it.y - it.h / 2 - 10 && columnFree(nid, prevY(first))) entries[first] = { side: "top", y: prevY(first) };
      if (!cornerExit(last) && prevY(last) > it.y + it.h / 2 + 10 && columnFree(nid, prevY(last))) entries[last] = { side: "bottom", y: prevY(last) };
    }
  }
  // A corner exit straight into a node must arrive at that node's entry y.
  for (const e of edgeIds) {
    if (cornerExit(e)) exits[e].y = entries[e].y;
  }

  // Abstract routes + corridor segments.
  const corridors: CorridorSeg[][] = Array.from({ length: L.ranks.length }, () => []);
  const routes: Record<string, RoutePt[]> = {};
  for (const e of edgeIds) {
    const chain = L.chains[e];
    const src = chain[0];
    const tgt = chain[chain.length - 1];
    const ex = exits[e];
    const en = entries[e];
    const pts: RoutePt[] = [];
    let runY: number;
    if (ex.side === "right") {
      pts.push({ x: { node: src, at: "right" }, y: ex.y });
      runY = ex.y;
    } else {
      const it = items[src];
      pts.push({ x: { node: src, at: "cx" }, y: ex.side === "top" ? it.y - it.h / 2 : it.y + it.h / 2 });
      runY = ex.y;
      pts.push({ x: { node: src, at: "cx" }, y: runY });
    }
    for (let i = 0; i < chain.length - 1; i++) {
      const last = i + 1 === chain.length - 1;
      const nextY = last ? (en.side === "left" ? en.y : runY) : items[chain[i + 1]].y;
      if (nextY !== runY) {
        const r = items[chain[i]].rank;
        const seg: CorridorSeg = { edge: e, y1: runY, y2: nextY };
        corridors[r].push(seg);
        const idx = corridors[r].length - 1;
        pts.push({ x: { corridor: r, seg: idx }, y: runY }, { x: { corridor: r, seg: idx }, y: nextY });
        runY = nextY;
      }
    }
    if (en.side === "left") {
      pts.push({ x: { node: tgt, at: "left" }, y: en.y });
    } else {
      const it = items[tgt];
      pts.push({ x: { node: tgt, at: "cx" }, y: runY }, { x: { node: tgt, at: "cx" }, y: en.side === "top" ? it.y - it.h / 2 : it.y + it.h / 2 });
    }
    routes[e] = pts;
  }

  for (const segs of corridors) orderTracks(segs);
  return { routes, corridors, exits, entries };
}

/**
 * Order the vertical segments of one corridor left→right to minimise crossings.
 * Segment A left of B: A's outgoing horizontal (y2) crosses B's vertical if y2
 * lies inside B's span; B's incoming horizontal (y1) crosses A's vertical if y1
 * lies inside A's span.
 */
function orderTracks(segs: CorridorSeg[]): void {
  if (segs.length < 2) {
    segs.forEach((s) => (s.x = 0));
    return;
  }
  const inside = (y: number, s: CorridorSeg) => y > Math.min(s.y1, s.y2) + 0.5 && y < Math.max(s.y1, s.y2) - 0.5;
  const cost = (a: CorridorSeg, b: CorridorSeg) => (inside(a.y2, b) ? 1 : 0) + (inside(b.y1, a) ? 1 : 0);
  const order: CorridorSeg[] = [];
  for (const s of segs) {
    let bestI = 0;
    let bestC = Infinity;
    for (let i = 0; i <= order.length; i++) {
      let c = 0;
      for (let j = 0; j < order.length; j++) c += j < i ? cost(order[j], s) : cost(s, order[j]);
      if (c < bestC) (bestC = c), (bestI = i);
    }
    order.splice(bestI, 0, s);
  }
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      if (cost(order[i + 1], order[i]) < cost(order[i], order[i + 1])) {
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
        improved = true;
      }
    }
    if (!improved) break;
  }
  order.forEach((s, i) => (s.x = i)); // track index; converted to px later
}

// ---------------------------------------------------------------------------
// Main entry

export function layoutScope(model: BpmnModel, scope: string, options: Partial<LayoutOptions> = {}): LayoutResult {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const adj = buildAdjacency(model, { scope, types: ["sequenceFlow"] });

  const layoutNodes = Object.keys(adj.outgoing).filter((id) => {
    const n = model.nodes[id];
    return n && n.type !== "boundaryEvent" && n.type !== "textAnnotation";
  });
  const inLayout = new Set(layoutNodes);
  const filteredAdj: Adjacency = { outgoing: {}, incoming: {} };
  for (const id of layoutNodes) {
    filteredAdj.outgoing[id] = (adj.outgoing[id] ?? []).filter((e) => inLayout.has(e.target));
    filteredAdj.incoming[id] = (adj.incoming[id] ?? []).filter((e) => inLayout.has(e.source));
  }

  const backEdges = detectBackEdges(filteredAdj);
  for (const e of Object.values(model.edges)) {
    if (e.type === "sequenceFlow") e.isBackEdge = backEdges.has(e.id);
  }
  const order = topoOrder(filteredAdj, backEdges);
  const rank = assignRanks(order, filteredAdj, backEdges);

  const proc = model.processes[scope];
  const laneIds = proc && proc.lanes.length ? [...proc.lanes] : [];
  const laneByNode: Record<string, string> = {};
  for (const lid of laneIds) for (const nid of model.lanes[lid].flowNodeRefs) laneByNode[nid] = lid;
  const lanes = laneIds.length ? laneIds : [NO_LANE];
  const laneOf = (id: string) => laneByNode[id] ?? lanes[0];
  const laneIndex: Record<string, number> = Object.fromEntries(lanes.map((l, i) => [l, i]));

  const L = buildLayered(model, layoutNodes, filteredAdj, backEdges, rank, laneOf, opts.longEdgeLane);
  orderRanksMultiStart(L, layoutNodes, (id) => laneIndex[L.items[id].lane], opts.sweeps);

  const loopsPerLane: Record<string, number> = {};
  for (const id of backEdges) {
    const e = model.edges[id];
    if (e) loopsPerLane[laneOf(e.source)] = (loopsPerLane[laneOf(e.source)] ?? 0) + 1;
  }
  const bands = assignY(L, lanes, loopsPerLane, opts);
  const plan = planRoutes(model, L);

  // X: column widths from real nodes, corridor widths from the number of tracks.
  const nR = L.ranks.length;
  const colW = L.ranks.map((rk) => Math.max(0, ...rk.map((id) => L.items[id].w)));
  // Corridors must also fit the condition labels of flows leaving a node to the right.
  const labelRoom: number[] = new Array(nR).fill(0);
  for (const [eid, ex] of Object.entries(plan.exits)) {
    const name = model.edges[eid].name;
    if (!name || ex.side !== "right") continue;
    const r = L.items[L.chains[eid][0]].rank;
    labelRoom[r] = Math.max(labelRoom[r], Math.min(100, Math.max(40, name.length * 6.2)) + 24);
  }
  const corridorW = plan.corridors.map((segs, r) => Math.max(opts.rankSep, (segs.length + 1) * TRACK_GAP, labelRoom[r]));
  const colX: number[] = [];
  const inset = laneIds.length ? POOL_GUTTER + LANE_INSET : 0;
  let x = opts.marginX + inset;
  for (let r = 0; r < nR; r++) {
    colX[r] = x + colW[r] / 2;
    x += colW[r] + (r < nR - 1 ? corridorW[r] : 0);
  }
  const contentRight = x;
  plan.corridors.forEach((segs, r) => {
    if (r >= nR - 1) return;
    const start = colX[r] + colW[r] / 2;
    const n = segs.length;
    for (const s of segs) s.x = Math.round(start + ((s.x! + 1) * corridorW[r]) / (n + 1));
  });

  // Commit node positions.
  for (const id of layoutNodes) {
    const it = L.items[id];
    const n = model.nodes[id];
    n.bounds.x = Math.round(colX[it.rank] - n.bounds.width / 2);
    n.bounds.y = Math.round(it.y - n.bounds.height / 2);
  }

  // Materialize forward routes.
  const resolveX = (ref: XRef): number => {
    if ("corridor" in ref) return plan.corridors[ref.corridor][ref.seg].x!;
    const b = model.nodes[ref.node].bounds;
    return ref.at === "left" ? b.x : ref.at === "right" ? b.x + b.width : b.x + b.width / 2;
  };
  const routed = new Set<string>();
  for (const [eid, pts] of Object.entries(plan.routes)) {
    const wps: Point[] = pts.map((p) => ({ x: resolveX(p.x), y: p.y }));
    model.edges[eid].waypoints = dedupe(wps);
    routed.add(eid);
  }

  // Lanes and pool.
  if (laneIds.length) {
    const laneX = opts.marginX + POOL_GUTTER;
    const laneW = contentRight + LANE_INSET - laneX;
    for (const lid of laneIds) {
      model.lanes[lid].bounds = { x: laneX, y: bands.laneTop[lid], width: laneW, height: bands.laneHeight[lid] };
    }
    const participant = Object.values(model.participants).find((p) => p.processRef === scope);
    if (participant) {
      const top = bands.laneTop[laneIds[0]];
      const last = laneIds[laneIds.length - 1];
      participant.bounds = {
        x: opts.marginX,
        y: top,
        width: laneW + POOL_GUTTER,
        height: bands.laneTop[last] + bands.laneHeight[last] - top,
      };
    }
  }

  placeBoundaryEvents(model, scope);

  const orderInRank: Record<string, number> = {};
  L.ranks.forEach((rk) => rk.filter((id) => !L.items[id].dummy).forEach((id, i) => (orderInRank[id] = i)));
  return { scope, rankOf: rank, orderInRank, backEdgeIds: backEdges, routed };
}

function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q.x === p.x && q.y === p.y) continue;
    // drop the middle of three collinear points
    const o = out[out.length - 2];
    if (o && q && ((o.x === q.x && q.x === p.x) || (o.y === q.y && q.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * Size task-like activities so their label fits inside the box (bpmn-js wraps
 * text but clips overflow). Events/gateways keep fixed sizes (their labels
 * render externally).
 */
export function fitLabelSizes(model: BpmnModel, scope: string): void {
  for (const n of Object.values(model.nodes)) {
    if (n.parent !== scope) continue;
    const taskLike = n.type === "task" || n.type.endsWith("Task") || n.type === "callActivity";
    if (!taskLike || !n.name) continue;
    const charsPerLine = 16;
    const longestWord = Math.max(...n.name.split(/\s+/).map((w) => w.length), 1);
    const width = Math.max(110, Math.min(170, longestWord * 7.2));
    const cpl = Math.max(charsPerLine, Math.floor((width - 16) / 6.6));
    const lines = Math.max(1, Math.ceil(n.name.length / cpl));
    const height = Math.max(70, Math.min(150, lines * 16 + 30));
    n.bounds.width = Math.round(width);
    n.bounds.height = Math.round(height);
  }
}

/** Place boundary events on the bottom border of their host activity. */
function placeBoundaryEvents(model: BpmnModel, scope: string): void {
  const boundaries = Object.values(model.nodes).filter((n) => n.parent === scope && n.type === "boundaryEvent" && n.attachedToRef);
  const byHost: Record<string, FlowNode[]> = {};
  for (const b of boundaries) (byHost[b.attachedToRef!] ||= []).push(b);
  for (const [hostId, list] of Object.entries(byHost)) {
    const host = model.nodes[hostId];
    if (!host) continue;
    const n = list.length;
    list.forEach((b, i) => {
      const frac = (i + 1) / (n + 1);
      b.bounds.x = Math.round(host.bounds.x + host.bounds.width * frac - b.bounds.width / 2);
      b.bounds.y = Math.round(host.bounds.y + host.bounds.height - b.bounds.height / 2);
    });
  }
}

/** Compute the bounding box of all laid-out content in a scope. */
export function contentBounds(model: BpmnModel, scope: string): { x: number; y: number; width: number; height: number } {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope);
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.bounds.x);
    minY = Math.min(minY, n.bounds.y);
    maxX = Math.max(maxX, n.bounds.x + n.bounds.width);
    maxY = Math.max(maxY, n.bounds.y + n.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
