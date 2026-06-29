import {
  Adjacency,
  BpmnModel,
  FlowNode,
  buildAdjacency,
  detectBackEdges,
  topoOrder,
} from "../model";

/**
 * Layered (Sugiyama-style) left-to-right layout tuned for BPMN.
 *
 * Why custom instead of bpmn-auto-layout: bpmn-auto-layout walks the flow and
 * places elements greedily; it produces acceptable trees but degrades badly on
 * graphs with joins, parallel branches that re-merge, and loops. Our pass does
 * proper rank assignment (longest path ignoring back edges), crossing-reduction
 * via the weighted-median heuristic, and barycenter coordinate assignment with
 * hard overlap resolution. Back edges are excluded from ranking so a loop never
 * drags its target into a later column — the dominant left-to-right reading
 * direction is preserved and the back edge is left for the router to fold
 * cleanly underneath the main path.
 */

export interface LayoutOptions {
  /** horizontal gap between rank columns. */
  rankSep: number;
  /** vertical gap between nodes within a column. */
  nodeSep: number;
  /** number of crossing-reduction sweeps. */
  sweeps: number;
  /** left/top margin inside the scope. */
  marginX: number;
  marginY: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  rankSep: 80,
  nodeSep: 50,
  sweeps: 6,
  marginX: 60,
  marginY: 60,
};

export interface LayoutResult {
  scope: string;
  rankOf: Record<string, number>;
  orderInRank: Record<string, number>;
  backEdgeIds: Set<string>;
}

/** Assign ranks by longest path over forward edges (back edges removed). */
function assignRanks(
  order: string[],
  adj: Adjacency,
  backEdges: Set<string>,
): Record<string, number> {
  const rank: Record<string, number> = {};
  for (const id of order) rank[id] = 0;
  // Process in topo order so all forward predecessors are finalized first.
  for (const id of order) {
    for (const e of adj.incoming[id] ?? []) {
      if (backEdges.has(e.id)) continue;
      rank[id] = Math.max(rank[id], (rank[e.source] ?? 0) + 1);
    }
  }
  return rank;
}

function groupByRank(rank: Record<string, number>): string[][] {
  const max = Math.max(0, ...Object.values(rank));
  const ranks: string[][] = Array.from({ length: max + 1 }, () => []);
  for (const id of Object.keys(rank)) ranks[rank[id]].push(id);
  return ranks;
}

/** Weighted-median crossing reduction (down + up sweeps). */
function reduceCrossings(
  ranks: string[][],
  adj: Adjacency,
  backEdges: Set<string>,
  sweeps: number,
): Record<string, number> {
  const pos: Record<string, number> = {};
  ranks.forEach((rk) => rk.forEach((id, i) => (pos[id] = i)));

  const neighborMedian = (id: string, dir: "in" | "out"): number => {
    const edges = (dir === "in" ? adj.incoming[id] : adj.outgoing[id]) ?? [];
    const ps = edges
      .filter((e) => !backEdges.has(e.id))
      .map((e) => pos[dir === "in" ? e.source : e.target])
      .filter((p) => p !== undefined)
      .sort((a, b) => a - b);
    if (ps.length === 0) return -1;
    const m = Math.floor(ps.length / 2);
    return ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2;
  };

  for (let s = 0; s < sweeps; s++) {
    const down = s % 2 === 0;
    const seq = down ? [...ranks.keys()] : [...ranks.keys()].reverse();
    for (const r of seq) {
      const dir = down ? "in" : "out";
      const withMed = ranks[r].map((id) => ({ id, med: neighborMedian(id, dir) }));
      // Keep elements with no neighbors (med = -1) fixed in place.
      const fixed = withMed.filter((w) => w.med < 0);
      const movable = withMed.filter((w) => w.med >= 0).sort((a, b) => a.med - b.med);
      const merged: string[] = [];
      let mi = 0;
      withMed.forEach((w, i) => {
        if (w.med < 0) merged[i] = w.id;
      });
      for (let i = 0; i < merged.length || mi < movable.length; i++) {
        if (merged[i] !== undefined) continue;
        if (mi < movable.length) merged[i] = movable[mi++].id;
      }
      ranks[r] = merged.filter((x) => x !== undefined);
      ranks[r].forEach((id, i) => (pos[id] = i));
      void fixed;
    }
  }
  return pos;
}

/** Barycenter y-coordinate assignment with overlap resolution. */
function assignCoordinates(
  model: BpmnModel,
  ranks: string[][],
  adj: Adjacency,
  backEdges: Set<string>,
  opts: LayoutOptions,
): void {
  // Column x positions from max width per rank.
  const colWidth = ranks.map((rk) =>
    rk.length ? Math.max(...rk.map((id) => model.nodes[id].bounds.width)) : 0,
  );
  const colX: number[] = [];
  let x = opts.marginX;
  for (let r = 0; r < ranks.length; r++) {
    colX[r] = x + colWidth[r] / 2; // center line of the column
    x += colWidth[r] + opts.rankSep;
  }

  // Initial y from order index.
  const y: Record<string, number> = {};
  for (const rk of ranks) {
    let cy = opts.marginY;
    for (const id of rk) {
      const h = model.nodes[id].bounds.height;
      y[id] = cy + h / 2;
      cy += h + opts.nodeSep;
    }
  }

  const rankOf: Record<string, number> = {};
  ranks.forEach((rk, r) => rk.forEach((id) => (rankOf[id] = r)));

  // Iterate: pull each node toward the average of its neighbors, then resolve
  // overlaps within each rank by spreading around the mean.
  for (let iter = 0; iter < 8; iter++) {
    const seq = iter % 2 === 0 ? [...ranks.keys()] : [...ranks.keys()].reverse();
    for (const r of seq) {
      for (const id of ranks[r]) {
        const edges = [...(adj.incoming[id] ?? []), ...(adj.outgoing[id] ?? [])].filter(
          (e) => !backEdges.has(e.id),
        );
        const ns = edges.map((e) => (e.source === id ? e.target : e.source));
        if (ns.length) {
          y[id] = ns.reduce((acc, n) => acc + y[n], 0) / ns.length;
        }
      }
      resolveOverlap(ranks[r], model, y, opts.nodeSep);
    }
  }

  // Commit positions: x = column center - width/2; y already center.
  for (let r = 0; r < ranks.length; r++) {
    for (const id of ranks[r]) {
      const n = model.nodes[id];
      n.bounds.x = Math.round(colX[r] - n.bounds.width / 2);
      n.bounds.y = Math.round(y[id] - n.bounds.height / 2);
    }
  }
}

/** Push apart nodes in a rank so vertical gaps respect nodeSep, keeping order. */
function resolveOverlap(
  rank: string[],
  model: BpmnModel,
  y: Record<string, number>,
  nodeSep: number,
): void {
  const sorted = [...rank].sort((a, b) => y[a] - y[b]);
  for (let i = 1; i < sorted.length; i++) {
    const prev = model.nodes[sorted[i - 1]];
    const cur = model.nodes[sorted[i]];
    const minCenter = y[sorted[i - 1]] + prev.bounds.height / 2 + nodeSep + cur.bounds.height / 2;
    if (y[sorted[i]] < minCenter) y[sorted[i]] = minCenter;
  }
}

/**
 * Run the layered layout for a scope. Mutates node bounds in place and returns
 * rank/order metadata used by the router and relayout features.
 */
export function layoutScope(
  model: BpmnModel,
  scope: string,
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const adj = buildAdjacency(model, { scope, types: ["sequenceFlow"] });

  // Boundary events are not part of the flow graph; lay them out on hosts after.
  const layoutNodes = Object.keys(adj.outgoing).filter((id) => {
    const n = model.nodes[id];
    return n && n.type !== "boundaryEvent" && n.type !== "textAnnotation";
  });
  const filteredAdj: Adjacency = { outgoing: {}, incoming: {} };
  for (const id of layoutNodes) {
    filteredAdj.outgoing[id] = (adj.outgoing[id] ?? []).filter((e) =>
      layoutNodes.includes(e.target),
    );
    filteredAdj.incoming[id] = (adj.incoming[id] ?? []).filter((e) =>
      layoutNodes.includes(e.source),
    );
  }

  const backEdges = detectBackEdges(filteredAdj);
  for (const e of Object.values(model.edges)) {
    if (e.type === "sequenceFlow") e.isBackEdge = backEdges.has(e.id);
  }
  const order = topoOrder(filteredAdj, backEdges);
  const rank = assignRanks(order, filteredAdj, backEdges);
  const ranks = groupByRank(rank);
  reduceCrossings(ranks, filteredAdj, backEdges, opts.sweeps);

  const proc = model.processes[scope];
  const hasLanes = !!proc && proc.lanes.length > 0;

  if (hasLanes) {
    layoutWithLanes(model, scope, ranks, filteredAdj, backEdges, opts);
  } else {
    assignCoordinates(model, ranks, filteredAdj, backEdges, opts);
  }

  placeBoundaryEvents(model, scope);

  const orderInRank: Record<string, number> = {};
  ranks.forEach((rk) => rk.forEach((id, i) => (orderInRank[id] = i)));
  return { scope, rankOf: rank, orderInRank, backEdgeIds: backEdges };
}

/**
 * Lane-aware placement: keep the global rank (x) but stack nodes inside their
 * lane's vertical band. Lanes are sized to fit their busiest column so swimlane
 * bands never overlap and each role reads as a clean horizontal track.
 */
function layoutWithLanes(
  model: BpmnModel,
  scope: string,
  ranks: string[][],
  adj: Adjacency,
  backEdges: Set<string>,
  opts: LayoutOptions,
): void {
  const proc = model.processes[scope];
  const laneIds = proc.lanes;
  const laneOf: Record<string, string> = {};
  for (const lid of laneIds) {
    for (const nid of model.lanes[lid].flowNodeRefs) laneOf[nid] = lid;
  }

  const colWidth = ranks.map((rk) =>
    rk.length ? Math.max(...rk.map((id) => model.nodes[id].bounds.width)) : 0,
  );
  const colX: number[] = [];
  let x = opts.marginX;
  for (let r = 0; r < ranks.length; r++) {
    colX[r] = x + colWidth[r] / 2;
    x += colWidth[r] + opts.rankSep;
  }
  const totalWidth = x - opts.rankSep + opts.marginX;

  // Compute each lane's required height: max over ranks of the stacked height
  // of that lane's nodes in that rank.
  const laneHeight: Record<string, number> = {};
  for (const lid of laneIds) {
    let maxH = 80;
    for (const rk of ranks) {
      const inLane = rk.filter((id) => laneOf[id] === lid);
      const stack =
        inLane.reduce((acc, id) => acc + model.nodes[id].bounds.height + opts.nodeSep, 0) -
        opts.nodeSep;
      maxH = Math.max(maxH, stack);
    }
    laneHeight[lid] = maxH + opts.nodeSep * 2;
  }

  // Assign lane vertical bands.
  const laneTop: Record<string, number> = {};
  let cy = opts.marginY;
  for (const lid of laneIds) {
    laneTop[lid] = cy;
    cy += laneHeight[lid];
  }

  // Place nodes: x by rank, y centered within lane band, barycenter-ordered.
  const yCenter: Record<string, number> = {};
  for (let r = 0; r < ranks.length; r++) {
    const byLane: Record<string, string[]> = {};
    for (const id of ranks[r]) (byLane[laneOf[id]] ||= []).push(id);
    for (const lid of laneIds) {
      const group = byLane[lid] ?? [];
      const bandCenter = laneTop[lid] + laneHeight[lid] / 2;
      const totalH =
        group.reduce((acc, id) => acc + model.nodes[id].bounds.height + opts.nodeSep, 0) -
        opts.nodeSep;
      let yy = bandCenter - totalH / 2;
      for (const id of group) {
        const h = model.nodes[id].bounds.height;
        yCenter[id] = yy + h / 2;
        yy += h + opts.nodeSep;
      }
    }
  }
  // A couple of barycenter passes constrained to lane bands.
  for (let iter = 0; iter < 4; iter++) {
    for (let r = 0; r < ranks.length; r++) {
      for (const id of ranks[r]) {
        const lid = laneOf[id];
        const edges = [...(adj.incoming[id] ?? []), ...(adj.outgoing[id] ?? [])].filter(
          (e) => !backEdges.has(e.id),
        );
        const ns = edges.map((e) => (e.source === id ? e.target : e.source)).filter((n) => laneOf[n] === lid);
        if (ns.length) yCenter[id] = ns.reduce((a, n) => a + yCenter[n], 0) / ns.length;
        // clamp inside band
        const half = model.nodes[id].bounds.height / 2;
        const lo = laneTop[lid] + opts.nodeSep + half;
        const hi = laneTop[lid] + laneHeight[lid] - opts.nodeSep - half;
        yCenter[id] = Math.min(hi, Math.max(lo, yCenter[id]));
      }
      const byLane: Record<string, string[]> = {};
      for (const id of ranks[r]) (byLane[laneOf[id]] ||= []).push(id);
      for (const lid of laneIds) resolveOverlap(byLane[lid] ?? [], model, yCenter, opts.nodeSep);
    }
  }

  for (let r = 0; r < ranks.length; r++) {
    for (const id of ranks[r]) {
      const n = model.nodes[id];
      n.bounds.x = Math.round(colX[r] - n.bounds.width / 2);
      n.bounds.y = Math.round(yCenter[id] - n.bounds.height / 2);
    }
  }

  // Size and position lane shapes.
  const laneX = opts.marginX - 30;
  const laneW = totalWidth - laneX + 30;
  for (const lid of laneIds) {
    model.lanes[lid].bounds = {
      x: laneX,
      y: laneTop[lid],
      width: laneW,
      height: laneHeight[lid],
    };
  }
}

/** Place boundary events on the bottom border of their host activity. */
function placeBoundaryEvents(model: BpmnModel, scope: string): void {
  const boundaries = Object.values(model.nodes).filter(
    (n) => n.parent === scope && n.type === "boundaryEvent" && n.attachedToRef,
  );
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
export function contentBounds(
  model: BpmnModel,
  scope: string,
): { x: number; y: number; width: number; height: number } {
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
