import { BpmnModel, Edge, FlowNode, Point, Waypoint } from "../model";
import {
  Side,
  inflate,
  pointOnSide,
  simplifyPath,
} from "../geometry/geometry";

/**
 * Orthogonal connection router.
 *
 * Forward edges are routed with a direction-aware A* over a uniform grid with a
 * turn penalty, so paths stay orthogonal, dodge other shapes, and minimise
 * bends. Crucially the router is *edge-aware*: every routed connection is
 * stamped into a shared occupancy field, so subsequent edges pay a penalty for
 * sharing a track and therefore spread out instead of overlapping — the main
 * thing naive per-edge routers (incl. bpmn-js' default) get wrong.
 *
 * Back edges (rework / loop returns) are folded into their own horizontal
 * channels beneath the content (reserved inside the pool by the layout), fanned
 * vertically so they never stack, keeping the forward reading direction intact.
 */

export interface RouteOptions {
  gridStep: number;
  clearance: number;
  turnPenalty: number;
  channelGap: number;
  /** soft cost added for routing over a cell already used by another edge. */
  edgePenalty: number;
  /** soft cost for cells adjacent to an existing edge (discourages hugging). */
  edgeNeighborPenalty: number;
}

export const DEFAULT_ROUTING: RouteOptions = {
  gridStep: 10,
  clearance: 16,
  turnPenalty: 16,
  channelGap: 34,
  edgePenalty: 40,
  edgeNeighborPenalty: 12,
};

const SIDE_DELTA: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** Route every connection in a scope, writing `edge.waypoints`. */
export function routeScope(
  model: BpmnModel,
  scope: string,
  options: Partial<RouteOptions> = {},
): void {
  const opts = { ...DEFAULT_ROUTING, ...options };
  const scopeNodes = Object.values(model.nodes).filter((n) => n.parent === scope);
  const edges = Object.values(model.edges).filter((e) => {
    const s = model.nodes[e.source];
    const t = model.nodes[e.target];
    return s && t && s.parent === scope && t.parent === scope && e.type !== "messageFlow";
  });

  // Fan assignment: distribute multiple flows along the shared side of a node.
  const outIndex = fanIndex(edges, (e) => e.source);
  const inIndex = fanIndex(edges, (e) => e.target);

  // Content extent for back-edge channels.
  const contentBottom = Math.max(...scopeNodes.map((n) => n.bounds.y + n.bounds.height), 0);

  const grid = buildGrid(scopeNodes, opts);
  const occupancy = new Float32Array(grid.W * grid.H);

  const backEdges = edges.filter((e) => e.isBackEdge);
  const fwdEdges = edges.filter((e) => !e.isBackEdge);

  // Route shorter / left-to-right edges first so the dominant flow claims the
  // straightest tracks and later edges detour around them. Deterministic.
  fwdEdges.sort((a, b) => {
    const sa = model.nodes[a.source].bounds;
    const sb = model.nodes[b.source].bounds;
    return sa.x - sb.x || sa.y - sb.y || a.id.localeCompare(b.id);
  });

  for (const e of fwdEdges) {
    e.waypoints = routeForward(model, e, grid, occupancy, opts, outIndex, inIndex);
    stampPath(occupancy, grid, e.waypoints, opts);
  }
  // Back edges last, A*-routed bottom→bottom so they dip into the reserved band
  // below the content (and around shapes/forward edges via occupancy) and rise
  // back into the target — instead of a rigid full-width channel.
  for (const e of backEdges) {
    e.waypoints = routeBackEdge(model, e, grid, occupancy, opts, outIndex, inIndex, contentBottom);
    stampPath(occupancy, grid, e.waypoints, opts);
  }
}

/** Mark the cells a routed path occupies (and their neighbours) as costly. */
function stampPath(occ: Float32Array, g: Grid, wps: Waypoint[] | undefined, opts: RouteOptions): void {
  if (!wps || wps.length < 2) return;
  const { W, H, step } = g;
  const mark = (cx: number, cy: number, v: number) => {
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return;
    occ[cy * W + cx] += v;
  };
  for (let i = 0; i < wps.length - 1; i++) {
    const a = toCell(wps[i], g);
    const b = toCell(wps[i + 1], g);
    const dx = Math.sign(b[0] - a[0]);
    const dy = Math.sign(b[1] - a[1]);
    let [cx, cy] = a;
    // walk the orthogonal segment cell by cell
    for (;;) {
      mark(cx, cy, opts.edgePenalty);
      // discourage running parallel right next to this track
      mark(cx + dy, cy + dx, opts.edgeNeighborPenalty);
      mark(cx - dy, cy - dx, opts.edgeNeighborPenalty);
      if (cx === b[0] && cy === b[1]) break;
      cx += dx;
      cy += dy;
    }
  }
  void step;
}

/** Assign each edge a 0-based index among siblings sharing the same endpoint. */
function fanIndex(edges: Edge[], key: (e: Edge) => string): Record<string, number> {
  const groups: Record<string, Edge[]> = {};
  for (const e of edges) (groups[key(e)] ||= []).push(e);
  const idx: Record<string, number> = {};
  for (const list of Object.values(groups)) {
    list.forEach((e, i) => (idx[e.id] = i));
  }
  return idx;
}

function fanFrac(index: number, count: number): number {
  if (count <= 1) return 0.5;
  // spread within [0.3, 0.7]
  return 0.3 + (0.4 * index) / (count - 1);
}

function siblingCount(edges: Record<string, Edge>, nodeId: string, role: "source" | "target"): number {
  return Object.values(edges).filter((e) => e[role] === nodeId && e.type !== "messageFlow").length;
}

/** Choose source/target sides for a forward edge from relative geometry. */
function chooseSides(s: FlowNode, t: FlowNode): { from: Side; to: Side } {
  const sc = { x: s.bounds.x + s.bounds.width / 2, y: s.bounds.y + s.bounds.height / 2 };
  const tc = { x: t.bounds.x + t.bounds.width / 2, y: t.bounds.y + t.bounds.height / 2 };
  const dx = tc.x - sc.x;
  const dy = tc.y - sc.y;
  // Predominantly horizontal flow → use right/left.
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }
  return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

interface Grid {
  originX: number;
  originY: number;
  W: number;
  H: number;
  blocked: (sourceId: string, targetId: string) => Uint8Array;
  step: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  nodeCells: Map<string, [number, number, number, number]>; // node -> cell rect
}

function buildGrid(nodes: FlowNode[], opts: RouteOptions): Grid {
  const step = opts.gridStep;
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
  const pad = 200; // room below content for loop channels + around for detours
  const originX = Math.floor((minX - pad) / step) * step;
  const originY = Math.floor((minY - pad) / step) * step;
  const W = Math.ceil((maxX + pad - originX) / step) + 1;
  const H = Math.ceil((maxY + pad - originY) / step) + 1;

  const nodeCells = new Map<string, [number, number, number, number]>();
  for (const n of nodes) {
    const r = inflate(n.bounds, opts.clearance);
    const x0 = Math.max(0, Math.floor((r.x - originX) / step));
    const y0 = Math.max(0, Math.floor((r.y - originY) / step));
    const x1 = Math.min(W - 1, Math.ceil((r.x + r.width - originX) / step));
    const y1 = Math.min(H - 1, Math.ceil((r.y + r.height - originY) / step));
    nodeCells.set(n.id, [x0, y0, x1, y1]);
  }

  const blocked = (sourceId: string, targetId: string): Uint8Array => {
    const arr = new Uint8Array(W * H);
    for (const [id, [x0, y0, x1, y1]] of nodeCells) {
      if (id === sourceId || id === targetId) continue;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) arr[cy * W + cx] = 1;
      }
    }
    return arr;
  };

  return { originX, originY, W, H, blocked, step, bounds: { minX, minY, maxX, maxY }, nodeCells };
}

function toCell(p: Point, g: Grid): [number, number] {
  return [
    Math.max(0, Math.min(g.W - 1, Math.round((p.x - g.originX) / g.step))),
    Math.max(0, Math.min(g.H - 1, Math.round((p.y - g.originY) / g.step))),
  ];
}
function toPoint(cx: number, cy: number, g: Grid): Point {
  return { x: g.originX + cx * g.step, y: g.originY + cy * g.step };
}

const DIRS: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Direction-aware A* on the grid. Returns cell-center points or null. */
function astar(
  g: Grid,
  blocked: Uint8Array,
  occupancy: Float32Array | null,
  start: [number, number],
  goal: [number, number],
  startDir: number,
  turnPenalty: number,
): Point[] | null {
  const { W, H } = g;
  const stateCount = W * H * 5;
  const gScore = new Float64Array(stateCount).fill(Infinity);
  const cameFrom = new Int32Array(stateCount).fill(-1);
  const sIdx = (cx: number, cy: number, d: number) => (cy * W + cx) * 5 + d;

  const h = (cx: number, cy: number) => (Math.abs(cx - goal[0]) + Math.abs(cy - goal[1])) * g.step;

  // simple binary heap
  const heap: number[] = []; // packed [f, state]
  const fOf: number[] = [];
  const push = (f: number, st: number) => {
    heap.push(st);
    fOf[st] = f;
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fOf[heap[p]] <= fOf[heap[i]]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = 2 * i + 2;
        let m = i;
        if (l < heap.length && fOf[heap[l]] < fOf[heap[m]]) m = l;
        if (r < heap.length && fOf[heap[r]] < fOf[heap[m]]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const startState = sIdx(start[0], start[1], startDir);
  gScore[startState] = 0;
  push(h(start[0], start[1]), startState);

  let goalState = -1;
  while (heap.length) {
    const st = pop();
    const d = st % 5;
    const cell = (st - d) / 5;
    const cx = cell % W;
    const cy = (cell - cx) / W;
    if (cx === goal[0] && cy === goal[1]) {
      goalState = st;
      break;
    }
    const baseG = gScore[st];
    for (let nd = 0; nd < 4; nd++) {
      const nx = cx + DIRS[nd][0];
      const ny = cy + DIRS[nd][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (blocked[ny * W + nx]) continue;
      const turn = d !== 4 && d !== nd ? turnPenalty : 0;
      const occ = occupancy ? occupancy[ny * W + nx] : 0;
      const ng = baseG + g.step + turn + occ;
      const ns = sIdx(nx, ny, nd);
      if (ng < gScore[ns]) {
        gScore[ns] = ng;
        cameFrom[ns] = st;
        push(ng + h(nx, ny), ns);
      }
    }
  }
  if (goalState < 0) return null;

  const path: Point[] = [];
  let cur = goalState;
  while (cur !== -1) {
    const d = cur % 5;
    const cell = (cur - d) / 5;
    const cx = cell % W;
    const cy = (cell - cx) / W;
    path.push(toPoint(cx, cy, g));
    cur = cameFrom[cur];
  }
  path.reverse();
  return path;
}

function dirIndexForSide(side: Side): number {
  switch (side) {
    case "top":
      return 0;
    case "right":
      return 1;
    case "bottom":
      return 2;
    case "left":
      return 3;
  }
}

function routeForward(
  model: BpmnModel,
  e: Edge,
  g: Grid,
  occupancy: Float32Array,
  opts: RouteOptions,
  outIdx: Record<string, number>,
  inIdx: Record<string, number>,
): Waypoint[] {
  const s = model.nodes[e.source];
  const t = model.nodes[e.target];
  const { from, to } = chooseSides(s, t);

  const outCount = siblingCount(model.edges, s.id, "source");
  const inCount = siblingCount(model.edges, t.id, "target");
  const fromFrac = fanFrac(outIdx[e.id] ?? 0, outCount);
  const toFrac = fanFrac(inIdx[e.id] ?? 0, inCount);

  const startPort = pointOnSide(s.bounds, from, fromFrac);
  const endPort = pointOnSide(t.bounds, to, toFrac);

  // Stub one grid step outside each node so the line leaves perpendicular.
  const stubOut = SIDE_DELTA[from];
  const stubIn = SIDE_DELTA[to];
  const stubStart = {
    x: startPort.x + stubOut.x * opts.gridStep,
    y: startPort.y + stubOut.y * opts.gridStep,
  };
  const stubEnd = {
    x: endPort.x + stubIn.x * opts.gridStep,
    y: endPort.y + stubIn.y * opts.gridStep,
  };

  const blocked = g.blocked(s.id, t.id);
  const startCell = toCell(stubStart, g);
  const goalCell = toCell(stubEnd, g);
  const path = astar(g, blocked, occupancy, startCell, goalCell, dirIndexForSide(from), opts.turnPenalty);

  let pts: Point[];
  if (path) {
    pts = [startPort, ...path, endPort];
  } else {
    // Fallback: simple L / Z route.
    pts = directOrthogonal(startPort, endPort, from);
  }
  return cleanupAnchors(simplifyPath(pts), startPort, endPort);
}

/**
 * Back-edge (loop) routing. Bottom→bottom ports, A*-routed so the loop dips
 * into the reserved band below the content and rises back into the target,
 * dodging shapes and (via occupancy) other flows — the Signavio-style loop that
 * avoids the long edge-hugging line a rigid channel produces.
 */
function routeBackEdge(
  model: BpmnModel,
  e: Edge,
  g: Grid,
  occupancy: Float32Array,
  opts: RouteOptions,
  outIdx: Record<string, number>,
  inIdx: Record<string, number>,
  contentBottom: number,
): Waypoint[] {
  const s = model.nodes[e.source];
  const t = model.nodes[e.target];
  const outCount = siblingCount(model.edges, s.id, "source");
  const inCount = siblingCount(model.edges, t.id, "target");
  const startPort = pointOnSide(s.bounds, "bottom", fanFrac(outIdx[e.id] ?? 0, outCount));
  const endPort = pointOnSide(t.bounds, "bottom", fanFrac(inIdx[e.id] ?? 0, inCount));

  // Bias A* into the reserved band: a temporary penalty field that makes the
  // rows between the content and the band cheap to traverse downward.
  const stubStart = { x: startPort.x, y: startPort.y + opts.gridStep };
  const stubEnd = { x: endPort.x, y: endPort.y + opts.gridStep };
  const blocked = g.blocked(s.id, t.id);
  const path = astar(g, blocked, occupancy, toCell(stubStart, g), toCell(stubEnd, g), 2, opts.turnPenalty);

  let pts: Point[];
  if (path) {
    pts = [startPort, ...path, endPort];
  } else {
    const channelY = contentBottom + opts.channelGap;
    pts = [startPort, { x: startPort.x, y: channelY }, { x: endPort.x, y: channelY }, endPort];
  }
  return cleanupAnchors(simplifyPath(pts), startPort, endPort);
}

function directOrthogonal(a: Point, b: Point, from: Side): Point[] {
  if (from === "right" || from === "left") {
    const midX = (a.x + b.x) / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  const midY = (a.y + b.y) / 2;
  return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
}

/** Ensure the first/last segments stay axis-aligned to the exact port points. */
function cleanupAnchors(pts: Point[], start: Point, end: Point): Point[] {
  if (pts.length < 2) return [start, end];
  const out = pts.slice();
  out[0] = start;
  out[out.length - 1] = end;
  // Snap the second point onto the start's axis to avoid a diagonal stub.
  const a = out[1];
  if (a.x !== start.x && a.y !== start.y) {
    out.splice(1, 0, { x: start.x, y: a.y });
  }
  const z = out[out.length - 2];
  if (z.x !== end.x && z.y !== end.y) {
    out.splice(out.length - 1, 0, { x: end.x, y: z.y });
  }
  return simplifyPath(out);
}

/** Simple side-to-side orthogonal route for message flows between pools. */
export function routeMessageFlows(model: BpmnModel): void {
  for (const e of Object.values(model.edges)) {
    if (e.type !== "messageFlow") continue;
    const s = model.nodes[e.source] ?? participantAsNode(model, e.source);
    const t = model.nodes[e.target] ?? participantAsNode(model, e.target);
    if (!s || !t) continue;
    const sc = s.bounds.y + s.bounds.height / 2;
    const tc = t.bounds.y + t.bounds.height / 2;
    const fromBottom = tc > sc;
    const startPort = pointOnSide(s.bounds, fromBottom ? "bottom" : "top", 0.5);
    const endPort = pointOnSide(t.bounds, fromBottom ? "top" : "bottom", 0.5);
    const midY = (startPort.y + endPort.y) / 2;
    e.waypoints = simplifyPath([
      startPort,
      { x: startPort.x, y: midY },
      { x: endPort.x, y: midY },
      endPort,
    ]);
  }
}

function participantAsNode(model: BpmnModel, id: string): FlowNode | undefined {
  const p = model.participants[id];
  if (!p) return undefined;
  return { id: p.id, type: "task", parent: "", bounds: p.bounds } as FlowNode;
}
