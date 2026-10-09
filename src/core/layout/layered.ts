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
  /**
   * Previous vertical position per element id. Used as the first starting
   * order of crossing reduction; on ties it wins, so an edited diagram keeps
   * its arrangement unless a different order has fewer crossings.
   */
  preferOrder?: Record<string, number>;
  /**
   * How loops (back edges) are drawn: as a reserved channel in the target's or
   * the source's lane, or left entirely to the A* router.
   */
  loopMode: "channel-target" | "channel-source" | "router";
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  rankSep: 64,
  nodeSep: 50,
  sweeps: 12,
  marginX: 60,
  marginY: 60,
  longEdgeLane: "source",
  loopMode: "channel-target",
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
  /** set on loop-channel dummies: the back edge they belong to. */
  loop?: string;
}

interface Layered {
  items: Record<string, Item>;
  ranks: string[][];
  adj: Adjacency;
  /** original edge id → [source, dummies…, target] */
  chains: Record<string, string[]>;
  /**
   * back edge id → channel dummies from the target's rank to the source's rank
   * (inclusive). A loop runs as its own track right below its target and back
   * along this channel, instead of being routed around the whole diagram.
   */
  loops: Record<string, string[]>;
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
  loopMode: LayoutOptions["loopMode"] = "channel-target",
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

  // Loop channels: one dummy per rank from the loop's target to its source, in
  // the target's lane. Consecutive dummies are linked so crossing reduction
  // sees the channel like any other flow.
  const loops: Record<string, string[]> = {};
  for (const id of nodeIds) {
    for (const e of adj.outgoing[id] ?? []) {
      if (loopMode === "router" || !backEdges.has(e.id) || !items[e.target] || e.source === e.target) continue;
      const rt = rank[e.target];
      const rs = rank[e.source];
      if (rs < rt) continue;
      const lane = loopMode === "channel-source" ? items[e.source].lane : items[e.target].lane;
      const chain: string[] = [];
      for (let r = rt; r <= rs; r++) {
        const did = `__loop_${e.id}_${r}`;
        items[did] = { id: did, dummy: true, lane, rank: r, w: 0, h: DUMMY_H, y: 0, loop: e.id };
        ladj.outgoing[did] = [];
        ladj.incoming[did] = [];
        chain.push(did);
      }
      for (let i = 0; i < chain.length - 1; i++) link(`${e.id}#loop${i}`, chain[i], chain[i + 1]);
      loops[e.id] = chain;
    }
  }

  return { items, ranks: initialOrder(items, ladj, nodeIds, false), adj: ladj, chains, loops };
}

/**
 * Put each loop channel's end dummies right next to the loop's target and
 * source, so the short vertical legs at both ends pass no other element.
 * Larger loops are handled first and end up outermost (nested, no crossings).
 */
function pinLoopEnds(L: Layered, model: BpmnModel, laneIdx: (id: string) => number): void {
  const span = (e: string) => L.loops[e].length;
  const ids = Object.keys(L.loops).sort((a, b) => span(b) - span(a) || a.localeCompare(b));
  const place = (dummy: string, anchor: string) => {
    const rank = L.ranks[L.items[dummy].rank];
    rank.splice(rank.indexOf(dummy), 1);
    const la = laneIdx(anchor);
    const ld = laneIdx(dummy);
    let at: number;
    if (la === ld) at = rank.indexOf(anchor) + 1;
    else if (ld > la) at = rank.findIndex((id) => laneIdx(id) >= ld); // top of a lane below
    else {
      const after = rank.findIndex((id) => laneIdx(id) > ld); // bottom of a lane above
      at = after < 0 ? rank.length : after;
    }
    rank.splice(at < 0 ? rank.length : at, 0, dummy);
  };
  for (const e of ids) {
    const chain = L.loops[e];
    const edge = model.edges[e];
    place(chain[0], edge.target);
    place(chain[chain.length - 1], edge.source);
  }
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
function orderRanksMultiStart(
  L: Layered,
  nodeIds: string[],
  laneIdx: (id: string) => number,
  sweeps: number,
  preferOrder?: Record<string, number>,
): void {
  const starts: string[][][] = [];
  if (preferOrder) starts.push(preferredOrder(L, laneIdx, preferOrder));
  starts.push(
    initialOrder(L.items, L.adj, nodeIds, false),
    initialOrder(L.items, L.adj, nodeIds, true),
  );
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const shuffles = Object.keys(L.items).length > 250 ? 1 : Object.keys(L.items).length > 120 ? 3 : 6;
  for (let k = 0; k < shuffles; k++) {
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
    sift(L, laneIdx);
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

/** Ranks sorted by the previous positions; new items/dummies take their neighbours' mean. */
function preferredOrder(L: Layered, laneIdx: (id: string) => number, prefer: Record<string, number>): string[][] {
  const key: Record<string, number> = {};
  for (const id of Object.keys(L.items)) if (prefer[id] !== undefined) key[id] = prefer[id];
  for (let pass = 0; pass < 4; pass++) {
    for (const id of Object.keys(L.items)) {
      if (key[id] !== undefined) continue;
      const ns = [...(L.adj.incoming[id] ?? []).map((e) => e.source), ...(L.adj.outgoing[id] ?? []).map((e) => e.target)]
        .map((n) => key[n])
        .filter((k): k is number => k !== undefined);
      if (ns.length) key[id] = ns.reduce((a, b) => a + b, 0) / ns.length;
    }
  }
  return L.ranks.map((rk) => [...rk].sort((a, b) => laneIdx(a) - laneIdx(b) || (key[a] ?? 0) - (key[b] ?? 0)));
}

/**
 * Sifting: move each item to the position within its lane group (in its rank)
 * that minimises crossings with the neighbouring ranks.
 */
function sift(L: Layered, laneIdx: (id: string) => number): void {
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let r = 0; r < L.ranks.length; r++) {
      const local = () =>
        (r > 0 ? layerCrossings(L.ranks[r - 1], L.ranks[r], L.adj) : 0) +
        (r < L.ranks.length - 1 ? layerCrossings(L.ranks[r], L.ranks[r + 1], L.adj) : 0);
      for (const id of [...L.ranks[r]]) {
        const rank = L.ranks[r];
        const lane = laneIdx(id);
        const from = rank.indexOf(id);
        rank.splice(from, 1);
        let best = from;
        let bestC = Infinity;
        for (let p = 0; p <= rank.length; p++) {
          // stay inside the lane group
          if (p > 0 && laneIdx(rank[p - 1]) > lane) break;
          if (p < rank.length && laneIdx(rank[p]) < lane) continue;
          rank.splice(p, 0, id);
          const c = local();
          rank.splice(p, 1);
          if (c < bestC || (c === bestC && p === from)) {
            bestC = c;
            best = p;
          }
        }
        rank.splice(best, 0, id);
        if (best !== from) improved = true;
      }
    }
    if (!improved) break;
  }
}

/** Crossings between the edges of two adjacent layers (inversion count, Fenwick tree). */
function layerCrossings(upper: string[], lower: string[], adj: Adjacency): number {
  const posU: Record<string, number> = {};
  upper.forEach((id, i) => (posU[id] = i));
  const seq: number[] = [];
  for (const v of lower) {
    const ups: number[] = [];
    for (const e of adj.incoming[v] ?? []) {
      const p = posU[e.source];
      if (p !== undefined) ups.push(p);
    }
    ups.sort((a, b) => a - b);
    for (const p of ups) seq.push(p);
  }
  // count pairs i<j with seq[i] > seq[j]
  const n = upper.length;
  const tree = new Int32Array(n + 1);
  let c = 0;
  let seen = 0;
  for (const p of seq) {
    // number of earlier values <= p
    let le = 0;
    for (let i = p + 1; i > 0; i -= i & -i) le += tree[i];
    c += seen - le;
    for (let i = p + 1; i <= n; i += i & -i) tree[i]++;
    seen++;
  }
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
  y1: number; // y of the horizontal attached on the LEFT of the track
  y2: number; // y of the horizontal attached on the RIGHT of the track
  x?: number;
  /** segment of a loop (runs right → left); its ports are never nudged. */
  loop?: boolean;
  /** loop segment given up (the loop is routed by A* instead). */
  dead?: boolean;
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
  // Vertical stretches of a column already used by corner routes (per rank).
  // [from, to, owner] — owner "node:side" lets flows sharing one corner bundle.
  const reserved: Record<number, [number, number, string][]> = {};
  const span = (nodeId: string, y: number): [number, number] => {
    const it = items[nodeId];
    return y < it.y ? [y - 10, it.y - it.h / 2] : [it.y + it.h / 2, y + 10];
  };
  const columnFree = (nodeId: string, y: number): boolean => {
    const it = items[nodeId];
    const [a, b] = span(nodeId, y);
    const itemsFree = L.ranks[it.rank].every((id) => {
      if (id === nodeId) return true;
      const o = items[id];
      return o.y + o.h / 2 + 6 < a || o.y - o.h / 2 - 6 > b;
    });
    return itemsFree && (reserved[it.rank] ?? []).every(([c, d]) => d + 6 < a || c - 6 > b);
  };
  const reserve = (nodeId: string, y: number, owner = "") =>
    (reserved[items[nodeId].rank] ||= []).push([...span(nodeId, y), owner]);

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
      // All branches clearly above leave via the top corner, all below via the
      // bottom corner (a trunk that branches off), the level one via the right
      // corner. All-or-nothing per direction: if the farthest branch cannot use
      // the corner, a nearer one using it would force a crossing.
      const above = outs.filter((e) => nextY(e) < it.y - it.h / 2 - 10);
      const below = outs.filter((e) => nextY(e) > it.y + it.h / 2 + 10);
      const top = above.length ? Math.min(...above.map(nextY)) : 0;
      const bottom = below.length ? Math.max(...below.map(nextY)) : 0;
      if (above.length && columnFree(nid, top)) {
        for (const e of above) exits[e] = { side: "top", y: nextY(e) };
        reserve(nid, top);
      }
      if (below.length && columnFree(nid, bottom)) {
        for (const e of below) exits[e] = { side: "bottom", y: nextY(e) };
        reserve(nid, bottom);
      }
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
      const cand = ins.filter((e) => !cornerExit(e));
      const above = cand.filter((e) => prevY(e) < it.y - it.h / 2 - 10);
      const below = cand.filter((e) => prevY(e) > it.y + it.h / 2 + 10);
      // all-or-nothing per direction, as for exits
      const top = above.length ? Math.min(...above.map(prevY)) : 0;
      const bottom = below.length ? Math.max(...below.map(prevY)) : 0;
      if (above.length && above.length === ins.filter((e) => prevY(e) < it.y - it.h / 2 - 10).length && columnFree(nid, top)) {
        for (const e of above) entries[e] = { side: "top", y: prevY(e) };
        reserve(nid, top);
      }
      if (below.length && below.length === ins.filter((e) => prevY(e) > it.y + it.h / 2 + 10).length && columnFree(nid, bottom)) {
        for (const e of below) entries[e] = { side: "bottom", y: prevY(e) };
        reserve(nid, bottom);
      }
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

  // Loops along their reserved channel: down (or up) from the source into the
  // channel, back left through the columns, and up (or down) into the target.
  // A loop whose legs are not clear, or whose corner a forward flow already
  // uses, is left to the A* router.
  const sideUsed = (nodeId: string, side: Side) =>
    Object.entries(exits).some(([e, p]) => L.chains[e][0] === nodeId && p.side === side) ||
    Object.entries(entries).some(([e, p]) => L.chains[e][L.chains[e].length - 1] === nodeId && p.side === side);
  const legFree = (nodeId: string, dummyId: string, owner: string) => {
    const it = items[nodeId];
    const d = items[dummyId];
    const [a, b] = d.y > it.y ? [it.y + it.h / 2, d.y + 4] : [d.y - 4, it.y - it.h / 2];
    const clear = L.ranks[it.rank].every((id) => {
      if (id === nodeId || id === dummyId) return true;
      const o = items[id];
      return o.y + o.h / 2 + 4 < a || o.y - o.h / 2 - 4 > b;
    });
    return clear && (reserved[it.rank] ?? []).every(([c, dd, own]) => own === owner || dd + 4 < a || c - 4 > b);
  };
  for (const [e, chain] of Object.entries(L.loops)) {
    const edge = model.edges[e];
    const src = edge.source;
    const tgt = edge.target;
    const dS = chain[chain.length - 1];
    const dT = chain[0];
    const sIt = items[src];
    const tIt = items[tgt];
    const exitSide: Side = items[dS].y > sIt.y ? "bottom" : "top";
    const entrySide: Side = items[dT].y > tIt.y ? "bottom" : "top";
    const sOwner = `${src}:${exitSide}`;
    const tOwner = `${tgt}:${entrySide}`;
    if (sideUsed(src, exitSide) || sideUsed(tgt, entrySide)) continue;
    if (!legFree(src, dS, sOwner) || !legFree(tgt, dT, tOwner)) continue;
    const edgeY = (it: Item, side: Side) => (side === "bottom" ? it.y + it.h / 2 : it.y - it.h / 2);
    const pts: RoutePt[] = [{ x: { node: src, at: "cx" }, y: edgeY(sIt, exitSide) }];
    let runY = items[dS].y;
    pts.push({ x: { node: src, at: "cx" }, y: runY });
    for (let i = chain.length - 1; i > 0; i--) {
      const nextY = items[chain[i - 1]].y;
      if (nextY !== runY) {
        const r = items[chain[i - 1]].rank; // corridor between rank r and r + 1
        corridors[r].push({ edge: e, y1: nextY, y2: runY, loop: true });
        const idx = corridors[r].length - 1;
        pts.push({ x: { corridor: r, seg: idx }, y: runY }, { x: { corridor: r, seg: idx }, y: nextY });
        runY = nextY;
      }
    }
    pts.push({ x: { node: tgt, at: "cx" }, y: runY }, { x: { node: tgt, at: "cx" }, y: edgeY(tIt, entrySide) });
    reserve(src, items[dS].y, sOwner);
    reserve(tgt, items[dT].y, tOwner);
    routes[e] = pts;
  }

  for (const segs of corridors) orderTracks(segs);

  // Same-y hand-offs can form a cycle no track order satisfies (e.g. a
  // staircase of long edges closed by a loop). A loop caught in such a cycle
  // gives up its channel and is routed by A* instead — never an overlap.
  for (let changed = true; changed; ) {
    changed = false;
    for (const segs of corridors) {
      for (const a of segs) {
        for (const b of segs) {
          if (a === b || a.dead || b.dead || a.x! > b.x! || Math.abs(a.y2 - b.y1) >= 0.5) continue;
          const victim = a.loop ? a.edge : b.loop ? b.edge : undefined;
          if (!victim) continue;
          delete routes[victim];
          for (const cs of corridors) for (const sg of cs) if (sg.loop && sg.edge === victim) sg.dead = true;
          changed = true;
        }
      }
    }
    if (changed) for (const segs of corridors) orderTracks(segs);
  }

  // A swap (A: y→y', B: y'→y between neighbouring columns) cannot be separated
  // by track order alone: one horizontal would lie on the other. Move the
  // activity port of one of them a few pixels so the two run apart.
  corridors.forEach((segs, r) => {
    for (const a of segs) {
      for (const b of segs) {
        if (a === b || a.dead || b.dead || a.loop || b.loop || a.x! > b.x! || Math.abs(a.y2 - b.y1) >= 0.5) continue;
        if (nudge(a.edge, "entry", a.y2) || nudge(b.edge, "exit", b.y1)) continue;
      }
    }
    void r;
  });
  function nudge(e: string, end: "entry" | "exit", y: number): boolean {
    const chain = L.chains[e];
    const nodeId = end === "entry" ? chain[chain.length - 1] : chain[0];
    const port = end === "entry" ? entries[e] : exits[e];
    if (kindOf(model.nodes[nodeId]) !== "activity" || port.side !== (end === "entry" ? "left" : "right")) return false;
    const it = items[nodeId];
    const ports = end === "entry" ? entries : exits;
    const taken = new Set(
      Object.keys(ports)
        .filter((id) => (end === "entry" ? L.chains[id][L.chains[id].length - 1] : L.chains[id][0]) === nodeId)
        .map((id) => ports[id].y),
    );
    for (const d of [10, -10, 18, -18]) {
      const ny = y + d;
      if (ny < it.y - it.h / 2 + 8 || ny > it.y + it.h / 2 - 8 || taken.has(ny)) continue;
      port.y = ny;
      for (const segs of corridors) for (const s of segs) {
        if (s.edge !== e) continue;
        if (end === "entry" && s.y2 === y) s.y2 = ny;
        if (end === "exit" && s.y1 === y) s.y1 = ny;
      }
      const pts = routes[e];
      if (end === "entry") {
        for (let i = pts.length - 1; i >= 0 && pts[i].y === y; i--) pts[i].y = ny;
      } else {
        for (let i = 0; i < pts.length && pts[i].y === y; i++) pts[i].y = ny;
      }
      return true;
    }
    return false;
  }
  return { routes, corridors, exits, entries };
}

/**
 * Order the vertical segments of one corridor left→right to minimise crossings.
 *
 * For a left of b: a's outgoing horizontal (y2) crosses b's vertical if y2 lies
 * inside b's span; b's incoming horizontal (y1) crosses a's vertical if y1 lies
 * inside a's span; and if a.y2 === b.y1 the two horizontals would lie on top of
 * each other (forbidden). The total is a sum of pairwise costs, so the optimal
 * order is a linear-ordering problem: solved exactly by dynamic programming
 * over subsets for up to EXACT_LIMIT segments, by local search beyond.
 */
const EXACT_LIMIT = 14;

function orderTracks(all: CorridorSeg[]): void {
  const segs = all.filter((sg) => !sg.dead);
  const n = segs.length;
  if (n < 2) {
    segs.forEach((s) => (s.x = 0));
    return;
  }
  const inside = (y: number, s: CorridorSeg) => y > Math.min(s.y1, s.y2) + 0.5 && y < Math.max(s.y1, s.y2) - 0.5;
  const C: number[][] = segs.map((a) =>
    segs.map((b) => (a === b ? 0 : (inside(a.y2, b) ? 1 : 0) + (inside(b.y1, a) ? 1 : 0) + (Math.abs(a.y2 - b.y1) < 0.5 ? 1000 : 0))),
  );

  let order: number[];
  if (n <= EXACT_LIMIT) {
    // best[mask] = min cost of the segments in `mask` occupying the leftmost tracks.
    const size = 1 << n;
    const best = new Float64Array(size).fill(Infinity);
    const choice = new Int8Array(size).fill(-1);
    best[0] = 0;
    for (let mask = 0; mask < size; mask++) {
      if (best[mask] === Infinity) continue;
      for (let s = 0; s < n; s++) {
        if (mask & (1 << s)) continue;
        let c = best[mask];
        for (let j = 0; j < n; j++) if (mask & (1 << j)) c += C[j][s];
        const next = mask | (1 << s);
        if (c < best[next]) {
          best[next] = c;
          choice[next] = s;
        }
      }
    }
    order = [];
    for (let mask = size - 1; mask; mask &= ~(1 << choice[mask])) order.unshift(choice[mask]);
  } else {
    // Local search: move each segment to its best position until stable.
    order = [...segs.keys()].sort((a, b) => segs[a].y1 + segs[a].y2 - segs[b].y1 - segs[b].y2);
    const total = (o: number[]) => {
      let c = 0;
      for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) c += C[o[i]][o[j]];
      return c;
    };
    let cur = total(order);
    for (let improved = true, guard = 0; improved && guard < 50; guard++) {
      improved = false;
      for (let i = 0; i < n; i++) {
        const item = order[i];
        const rest = order.filter((_, k) => k !== i);
        for (let p = 0; p <= rest.length; p++) {
          const cand = [...rest.slice(0, p), item, ...rest.slice(p)];
          const c = total(cand);
          if (c < cur) {
            cur = c;
            order = cand;
            improved = true;
            break;
          }
        }
      }
    }
  }
  order.forEach((segIdx, i) => (segs[segIdx].x = i)); // track index; converted to px later
}

// ---------------------------------------------------------------------------
// Main entry

export function layoutScope(model: BpmnModel, scope: string, options: Partial<LayoutOptions> = {}): LayoutResult {
  // The exception path after a boundary event continues from its host: place
  // it after the host (proxy flows host → target, removed again below).
  const proxies = boundaryProxies(model, scope);
  try {
    return layoutScopeInner(model, scope, options);
  } finally {
    for (const id of proxies) delete model.edges[id];
  }
}

const PROXY_PREFIX = "__boundary_proxy__";

function boundaryProxies(model: BpmnModel, scope: string): string[] {
  const ids: string[] = [];
  for (const e of Object.values(model.edges)) {
    if (e.type !== "sequenceFlow") continue;
    const b = model.nodes[e.source];
    if (!b || b.parent !== scope || b.type !== "boundaryEvent" || !b.attachedToRef || !model.nodes[b.attachedToRef]) continue;
    const id = `${PROXY_PREFIX}${e.id}`;
    model.edges[id] = { id, type: "sequenceFlow", source: b.attachedToRef, target: e.target };
    ids.push(id);
  }
  return ids;
}

function layoutScopeInner(model: BpmnModel, scope: string, options: Partial<LayoutOptions> = {}): LayoutResult {
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
    if (e.type === "sequenceFlow") e.isBackEdge = backEdges.has(e.id) || backEdges.has(`${PROXY_PREFIX}${e.id}`);
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

  const L = buildLayered(model, layoutNodes, filteredAdj, backEdges, rank, laneOf, opts.longEdgeLane, opts.loopMode);
  orderRanksMultiStart(L, layoutNodes, (id) => laneIndex[L.items[id].lane], opts.sweeps, opts.preferOrder);
  pinLoopEnds(L, model, (id) => laneIndex[L.items[id].lane]);

  // Loops reserve their channel through dummies; no extra lane space needed.
  const bands = assignY(L, lanes, {}, opts);
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
  const corridorW = plan.corridors.map((segs, r) =>
    Math.max(opts.rankSep, (segs.filter((sg) => !sg.dead).length + 1) * TRACK_GAP, labelRoom[r]),
  );
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
    const live = segs.filter((sg) => !sg.dead);
    const n = live.length;
    for (const s of live) s.x = Math.round(start + ((s.x! + 1) * corridorW[r]) / (n + 1));
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
    if (eid.startsWith(PROXY_PREFIX)) continue; // the real flow starts at the boundary event: routed afterwards
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

  // A lane-less process that still has its own pool (e.g. because of external
  // partners) gets a frame around its content.
  const ownPool = Object.values(model.participants).find((p) => p.processRef === scope);
  if (ownPool && !laneIds.length && layoutNodes.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of layoutNodes) {
      const b = model.nodes[id].bounds;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    ownPool.bounds = { x: minX - POOL_GUTTER - 50, y: minY - 50, width: maxX - minX + POOL_GUTTER + 100, height: maxY - minY + 100 };
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

/**
 * Internals exposed for verification scripts/tests only (e.g. comparing the
 * crossing reduction against an exhaustive optimum on small graphs).
 */
export const __layeredInternals = {
  prepare(model: BpmnModel, scope: string) {
    const adj = buildAdjacency(model, { scope, types: ["sequenceFlow"] });
    const nodes = Object.keys(adj.outgoing).filter((id) => model.nodes[id] && model.nodes[id].type !== "boundaryEvent");
    const set = new Set(nodes);
    const fadj: Adjacency = { outgoing: {}, incoming: {} };
    for (const id of nodes) {
      fadj.outgoing[id] = (adj.outgoing[id] ?? []).filter((e) => set.has(e.target));
      fadj.incoming[id] = (adj.incoming[id] ?? []).filter((e) => set.has(e.source));
    }
    const back = detectBackEdges(fadj);
    const rank = assignRanks(topoOrder(fadj, back), fadj, back);
    const proc = model.processes[scope];
    const lanes = proc && proc.lanes.length ? [...proc.lanes] : [NO_LANE];
    const laneBy: Record<string, string> = {};
    for (const l of proc?.lanes ?? []) for (const n of model.lanes[l].flowNodeRefs) laneBy[n] = l;
    const laneOf = (id: string) => laneBy[id] ?? lanes[0];
    const L = buildLayered(model, nodes, fadj, back, rank, laneOf, "source");
    const laneIdx = (id: string) => lanes.indexOf(L.items[id].lane);
    return { L, nodes, laneIdx };
  },
  orderRanksMultiStart,
  total(L: Layered): number {
    let c = 0;
    for (let r = 0; r < L.ranks.length - 1; r++) c += layerCrossings(L.ranks[r], L.ranks[r + 1], L.adj);
    return c;
  },
};
