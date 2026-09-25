import { BpmnModel, Bounds, Edge, FlowNode, Point, Waypoint } from "../model";
import { Side, inflate, pointOnSide, simplifyPath } from "../geometry/geometry";

/**
 * Orthogonal A* connection router.
 *
 * Used for everything the layered layout does not route itself: loop/back
 * edges after an auto-layout, and *all* flows when re-routing a manually
 * arranged diagram ("Kanten aufräumen").
 *
 * - Direction-aware A* (state = cell × heading) with a turn penalty → few bends.
 * - Occupancy is tracked separately for horizontal and vertical use. Running
 *   along a track another flow already uses (an overlap) is prohibitively
 *   expensive; crossing it at a right angle costs a moderate penalty. So the
 *   router detours rather than overlaps, and only crosses when a detour would
 *   be long.
 * - Ports are candidates, not fixed: activities offer points on each side,
 *   gateways and events their real corners/side midpoints. A* starts from all
 *   source candidates and finishes at the cheapest target candidate. Ports
 *   already taken by other flows are strongly discouraged.
 * - The search is confined to the pool (or the content area when there is no
 *   pool), so flows never leave the diagram frame.
 */

export interface RouteOptions {
  gridStep: number;
  /** clearance kept around shapes. */
  clearance: number;
  turnPenalty: number;
  /** cost for running along a track another flow already uses. */
  overlapPenalty: number;
  /** cost for crossing another flow at a right angle. */
  crossPenalty: number;
  /** cost for running right next to another flow. */
  hugPenalty: number;
}

export const DEFAULT_ROUTING: RouteOptions = {
  gridStep: 10,
  clearance: 12,
  turnPenalty: 20,
  overlapPenalty: 5000,
  crossPenalty: 1500,
  hugPenalty: 6,
};

const DIRS: Array<[number, number]> = [
  [0, -1], // 0 up
  [1, 0], // 1 right
  [0, 1], // 2 down
  [-1, 0], // 3 left
];
/** 1 = exact A*. (1.5 was measured: 25 % faster but more loop crossings — not worth it.) */
const HEURISTIC_WEIGHT = 1;
const SIDE_DIR: Record<Side, number> = { top: 0, right: 1, bottom: 2, left: 3 };

export interface RouteContext {
  /** edges that already have final waypoints (e.g. from the layout) — kept, but used as obstacles. */
  keep?: Set<string>;
}

/** Route connections in a scope, writing `edge.waypoints`. */
export function routeScope(model: BpmnModel, scope: string, options: Partial<RouteOptions> = {}, ctx: RouteContext = {}): void {
  const opts = { ...DEFAULT_ROUTING, ...options };
  const scopeNodes = Object.values(model.nodes).filter((n) => n.parent === scope);
  const edges = Object.values(model.edges).filter((e) => {
    const s = model.nodes[e.source];
    const t = model.nodes[e.target];
    return s && t && s.parent === scope && t.parent === scope && e.type !== "messageFlow";
  });
  if (!scopeNodes.length) return;

  const grid = buildGrid(model, scope, scopeNodes, opts);
  const occ = { h: new Float32Array(grid.W * grid.H), v: new Float32Array(grid.W * grid.H), near: new Float32Array(grid.W * grid.H) };
  const usedPorts = new Map<string, number>(); // "node|x|y" → count

  const keep = ctx.keep ?? new Set<string>();
  for (const e of edges) {
    if (!keep.has(e.id) || !e.waypoints) continue;
    stamp(occ, grid, e.waypoints, opts);
    markPort(usedPorts, e.source, e.waypoints[0]);
    markPort(usedPorts, e.target, e.waypoints[e.waypoints.length - 1]);
  }

  const todo = edges.filter((e) => !keep.has(e.id));
  // Forward edges first (left→right), loops last so they route around the main flow.
  todo.sort((a, b) => {
    if (!!a.isBackEdge !== !!b.isBackEdge) return a.isBackEdge ? 1 : -1;
    const sa = model.nodes[a.source].bounds;
    const sb = model.nodes[b.source].bounds;
    return sa.x - sb.x || sa.y - sb.y || a.id.localeCompare(b.id);
  });

  const place = (e: Edge, wps: Waypoint[], sign: 1 | -1) => {
    stamp(occ, grid, wps, opts, sign);
    markPort(usedPorts, e.source, wps[0], sign);
    markPort(usedPorts, e.target, wps[wps.length - 1], sign);
  };
  for (const e of todo) {
    e.waypoints = routeEdge(model, e, grid, occ, usedPorts, opts);
    place(e, e.waypoints, 1);
  }

  // Rip-up and reroute: edges that still cross others are re-routed once all
  // other flows are known; the new route is kept only if it crosses less.
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const e of todo) {
      const before = crossingsOf(e, edges);
      if (!before) continue;
      const old = e.waypoints!;
      place(e, old, -1);
      const wps = routeEdge(model, e, grid, occ, usedPorts, opts);
      e.waypoints = wps;
      if (crossingsOf(e, edges) < before) {
        place(e, wps, 1);
        changed = true;
      } else {
        e.waypoints = old;
        place(e, old, 1);
      }
    }
    if (!changed) break;
  }
}

/** Proper crossings of one routed edge with all other routed edges. */
function crossingsOf(e: Edge, edges: Edge[]): number {
  const a = e.waypoints;
  if (!a) return 0;
  let c = 0;
  for (const o of edges) {
    if (o === e || !o.waypoints) continue;
    const b = o.waypoints;
    for (let i = 0; i < a.length - 1; i++) {
      for (let j = 0; j < b.length - 1; j++) {
        const [p, q, r, t] = [a[i], a[i + 1], b[j], b[j + 1]];
        const h1 = p.y === q.y;
        const h2 = r.y === t.y;
        if (h1 === h2) continue;
        const [H0, H1, V0, V1] = h1 ? [p, q, r, t] : [r, t, p, q];
        const x = V0.x;
        const y = H0.y;
        if (x > Math.min(H0.x, H1.x) && x < Math.max(H0.x, H1.x) && y > Math.min(V0.y, V1.y) && y < Math.max(V0.y, V1.y)) c++;
      }
    }
  }
  return c;
}

const portKey = (node: string, p: Point) => `${node}|${Math.round(p.x)}|${Math.round(p.y)}`;
function markPort(used: Map<string, number>, node: string, p: Point, sign: 1 | -1 = 1) {
  const k = portKey(node, p);
  used.set(k, (used.get(k) ?? 0) + sign);
}

// ---------------------------------------------------------------------------
// Grid

interface Grid {
  originX: number;
  originY: number;
  W: number;
  H: number;
  step: number;
  /** cells outside the allowed frame. */
  outside: Uint8Array;
  nodeCells: Map<string, [number, number, number, number]>;
  /** number of (inflated) shapes covering each cell. */
  nodeCount: Uint16Array;
  /** search buffers, allocated once per grid and reset per search. */
  buf?: { gScore: Float64Array; came: Int32Array; startOf: Int32Array };
}

function buildGrid(model: BpmnModel, scope: string, nodes: FlowNode[], opts: RouteOptions): Grid {
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
  const pool = Object.values(model.participants).find((p) => p.processRef === scope);
  // Allowed frame: inside the pool's lane area, or the content plus a margin.
  const frame: Bounds = pool
    ? { x: pool.bounds.x + 30 + 4, y: pool.bounds.y + 4, width: pool.bounds.width - 30 - 8, height: pool.bounds.height - 8 }
    : { x: minX - 80, y: minY - 80, width: maxX - minX + 160, height: maxY - minY + 160 };
  minX = Math.min(minX, frame.x);
  minY = Math.min(minY, frame.y);
  maxX = Math.max(maxX, frame.x + frame.width);
  maxY = Math.max(maxY, frame.y + frame.height);

  const pad = 2 * step;
  const originX = Math.floor((minX - pad) / step) * step;
  const originY = Math.floor((minY - pad) / step) * step;
  const W = Math.ceil((maxX + pad - originX) / step) + 1;
  const H = Math.ceil((maxY + pad - originY) / step) + 1;

  const outside = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const x = originX + cx * step;
      const y = originY + cy * step;
      if (x < frame.x || x > frame.x + frame.width || y < frame.y || y > frame.y + frame.height) outside[cy * W + cx] = 1;
    }
  }

  const nodeCells = new Map<string, [number, number, number, number]>();
  for (const n of nodes) {
    if (n.type === "boundaryEvent") continue;
    const r = inflate(n.bounds, opts.clearance);
    nodeCells.set(n.id, [
      Math.max(0, Math.floor((r.x - originX) / step)),
      Math.max(0, Math.floor((r.y - originY) / step)),
      Math.min(W - 1, Math.ceil((r.x + r.width - originX) / step)),
      Math.min(H - 1, Math.ceil((r.y + r.height - originY) / step)),
    ]);
  }
  const nodeCount = new Uint16Array(W * H);
  for (const [x0, y0, x1, y1] of nodeCells.values()) {
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) nodeCount[cy * W + cx]++;
  }
  return { originX, originY, W, H, step, outside, nodeCells, nodeCount };
}

/** Temporarily let a flow pass through its own source/target shapes (sign -1), then restore (+1). */
function toggleOwnShapes(g: Grid, ids: string[], sign: 1 | -1): void {
  for (const id of ids) {
    const r = g.nodeCells.get(id);
    if (!r) continue;
    const [x0, y0, x1, y1] = r;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) g.nodeCount[cy * g.W + cx] += sign;
  }
}

function toCell(p: Point, g: Grid): [number, number] {
  return [
    Math.max(0, Math.min(g.W - 1, Math.round((p.x - g.originX) / g.step))),
    Math.max(0, Math.min(g.H - 1, Math.round((p.y - g.originY) / g.step))),
  ];
}
const toPoint = (cx: number, cy: number, g: Grid): Point => ({ x: g.originX + cx * g.step, y: g.originY + cy * g.step });

interface Occupancy {
  h: Float32Array;
  v: Float32Array;
  near: Float32Array;
}

/** Record a routed path in the occupancy fields. */
function stamp(occ: Occupancy, g: Grid, wps: Waypoint[], opts: RouteOptions, sign: 1 | -1 = 1): void {
  const { W, H } = g;
  const inGrid = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < W && cy < H;
  for (let i = 0; i < wps.length - 1; i++) {
    const a = toCell(wps[i], g);
    const b = toCell(wps[i + 1], g);
    const horizontal = a[1] === b[1];
    const dx = Math.sign(b[0] - a[0]);
    const dy = Math.sign(b[1] - a[1]);
    let [cx, cy] = a;
    for (;;) {
      const k = cy * W + cx;
      if (horizontal) occ.h[k] += sign;
      else occ.v[k] += sign;
      for (const [nx, ny] of horizontal ? [[cx, cy - 1], [cx, cy + 1]] : [[cx - 1, cy], [cx + 1, cy]]) {
        if (inGrid(nx, ny)) occ.near[ny * W + nx] += sign * opts.hugPenalty;
      }
      if (cx === b[0] && cy === b[1]) break;
      cx += dx;
      cy += dy;
    }
  }
}

// ---------------------------------------------------------------------------
// Ports

interface Port {
  point: Point;
  side: Side;
  cost: number;
}

const isGateway = (n: FlowNode) => n.type.endsWith("Gateway");
const isEvent = (n: FlowNode) => n.type.endsWith("Event");

function candidatePorts(node: FlowNode, other: FlowNode, role: "out" | "in", back: boolean, used: Map<string, number>): Port[] {
  const b = node.bounds;
  const oc = { x: other.bounds.x + other.bounds.width / 2, y: other.bounds.y + other.bounds.height / 2 };
  const nc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = oc.x - nc.x;
  const dy = oc.y - nc.y;

  // Side preference by direction of travel.
  const sideCost = (side: Side): number => {
    if (back) return { bottom: 0, top: 12, left: 60, right: 60 }[side];
    const toward: Side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "bottom" : "top";
    const main: Side = role === "out" ? (dx >= 0 ? "right" : "left") : dx >= 0 ? "left" : "right";
    if (role === "out" && side === toward) return 0;
    if (role === "in") {
      const into: Side = ({ right: "left", left: "right", top: "bottom", bottom: "top" } as const)[toward];
      if (side === into) return 0;
    }
    if (side === main) return 4;
    const vertical: Side = role === "out" ? (dy >= 0 ? "bottom" : "top") : dy >= 0 ? "top" : "bottom";
    return side === vertical ? 10 : 80;
  };

  const sides: Side[] = ["right", "left", "top", "bottom"];
  const fracs = isGateway(node) || isEvent(node) ? [0.5] : [0.5, 0.3, 0.7, 0.15, 0.85];
  const ports: Port[] = [];
  for (const side of sides) {
    fracs.forEach((f, i) => {
      const point = pointOnSide(b, side, f);
      const taken = used.get(portKey(node.id, point)) ?? 0;
      ports.push({ point, side, cost: sideCost(side) + i * 3 + taken * 400 });
    });
  }
  return ports;
}

// ---------------------------------------------------------------------------
// A*

function routeEdge(
  model: BpmnModel,
  e: Edge,
  g: Grid,
  occ: Occupancy,
  used: Map<string, number>,
  opts: RouteOptions,
): Waypoint[] {
  const s = model.nodes[e.source];
  const t = model.nodes[e.target];
  const back = !!e.isBackEdge;
  const outs = candidatePorts(s, t, "out", back, used);
  const ins = candidatePorts(t, s, "in", back, used);
  // Search window: the horizontal span of the two shapes plus a generous margin
  // (loops and detours stay local), full frame height.
  const margin = Math.ceil(600 / g.step);
  const x0 = Math.max(0, Math.floor((Math.min(s.bounds.x, t.bounds.x) - g.originX) / g.step) - margin);
  const x1 = Math.min(g.W - 1, Math.ceil((Math.max(s.bounds.x + s.bounds.width, t.bounds.x + t.bounds.width) - g.originX) / g.step) + margin);
  const own = [...new Set([s.id, t.id])];
  toggleOwnShapes(g, own, -1);
  let found: ReturnType<typeof astar>;
  try {
    found = astar(g, (k, cx) => cx < x0 || cx > x1 || g.outside[k] === 1 || g.nodeCount[k] > 0, occ, outs, ins, opts);
  } finally {
    toggleOwnShapes(g, own, 1);
  }
  if (!found) {
    const a = outs.sort((x, y) => x.cost - y.cost)[0];
    const z = ins.sort((x, y) => x.cost - y.cost)[0];
    return fallback(a.point, z.point, a.side);
  }
  const { path, from, to } = found;
  snapRun(path, from, false);
  snapRun(path, to, true);
  return cleanupAnchors(simplifyPath([from.point, ...path, to.point]), from.point, to.point);
}

function astar(
  g: Grid,
  blocked: (k: number, cx: number) => boolean,
  occ: Occupancy,
  starts: Port[],
  goals: Port[],
  opts: RouteOptions,
): { path: Point[]; from: Port; to: Port } | null {
  const { W, H, step } = g;
  const N = W * H * 4;
  if (!g.buf) {
    g.buf = { gScore: new Float64Array(N).fill(Infinity), came: new Int32Array(N).fill(-1), startOf: new Int32Array(N).fill(-1) };
  }
  const { gScore, came, startOf } = g.buf;
  const touched: number[] = [];
  const touch = (s: number) => {
    if (gScore[s] === Infinity) touched.push(s);
  };
  try {
    return search();
  } finally {
    for (const s of touched) {
      gScore[s] = Infinity;
      came[s] = -1;
      startOf[s] = -1;
    }
  }

  function search(): { path: Point[]; from: Port; to: Port } | null {
  const st = (cx: number, cy: number, d: number) => (cy * W + cx) * 4 + d;

  // Goal lookup: stub cell → ports ending there (with the heading that enters the port).
  const goalAt = new Map<number, { port: Port; dir: number }[]>();
  const goalCells: [number, number][] = [];
  for (const p of goals) {
    const d = SIDE_DIR[p.side];
    const stub = { x: p.point.x + DIRS[d][0] * step, y: p.point.y + DIRS[d][1] * step };
    const [cx, cy] = toCell(stub, g);
    const k = cy * W + cx;
    if (!goalAt.has(k)) goalAt.set(k, []);
    goalAt.get(k)!.push({ port: p, dir: (d + 2) % 4 });
    goalCells.push([cx, cy]);
  }
  const h = (cx: number, cy: number) => {
    let best = Infinity;
    for (const [gx, gy] of goalCells) best = Math.min(best, Math.abs(cx - gx) + Math.abs(cy - gy));
    return best * step * HEURISTIC_WEIGHT;
  };

  // Binary heap over (f, state); terminal states are encoded as N + goalIndex.
  const heapS: number[] = [];
  const heapF: number[] = [];
  const push = (f: number, s: number) => {
    heapS.push(s);
    heapF.push(f);
    let i = heapS.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapS[p], heapS[i]] = [heapS[i], heapS[p]];
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapS[0];
    const ls = heapS.pop()!;
    const lf = heapF.pop()!;
    if (heapS.length) {
      heapS[0] = ls;
      heapF[0] = lf;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapS.length && heapF[l] < heapF[m]) m = l;
        if (r < heapS.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heapS[m], heapS[i]] = [heapS[i], heapS[m]];
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        i = m;
      }
    }
    return top;
  };

  starts.forEach((p, i) => {
    const d = SIDE_DIR[p.side];
    const stub = { x: p.point.x + DIRS[d][0] * step, y: p.point.y + DIRS[d][1] * step };
    const [cx, cy] = toCell(stub, g);
    if (blocked(cy * W + cx, cx)) return;
    const s = st(cx, cy, d);
    const cost = p.cost + cellCost(occ, cy * W + cx, d, opts);
    if (cost < gScore[s]) {
      touch(s);
      gScore[s] = cost;
      startOf[s] = i;
      push(cost + h(cx, cy), s);
    }
  });

  const terminal: { state: number; port: Port; cost: number }[] = [];
  let bestTerminal = -1;
  while (heapS.length) {
    const s = pop();
    if (s >= N) {
      bestTerminal = s - N;
      break;
    }
    const d = s % 4;
    const cell = (s - d) / 4;
    const cx = cell % W;
    const cy = (cell - cx) / W;
    const base = gScore[s];
    const goalsHere = goalAt.get(cell);
    if (goalsHere) {
      for (const gp of goalsHere) {
        const total = base + gp.port.cost + (d === gp.dir ? 0 : opts.turnPenalty * (d === (gp.dir + 2) % 4 ? 3 : 1));
        terminal.push({ state: s, port: gp.port, cost: total });
        push(total, N + terminal.length - 1);
      }
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue; // no U-turns
      const nx = cx + DIRS[nd][0];
      const ny = cy + DIRS[nd][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nk = ny * W + nx;
      if (blocked(nk, nx)) continue;
      const ng = base + step + (nd !== d ? opts.turnPenalty : 0) + cellCost(occ, nk, nd, opts);
      const ns = st(nx, ny, nd);
      if (ng < gScore[ns]) {
        touch(ns);
        gScore[ns] = ng;
        came[ns] = s;
        startOf[ns] = startOf[s];
        push(ng + h(nx, ny), ns);
      }
    }
  }
  if (bestTerminal < 0) return null;

  const term = terminal[bestTerminal];
  const path: Point[] = [];
  let cur = term.state;
  let first = cur;
  while (cur !== -1) {
    const cell = (cur - (cur % 4)) / 4;
    path.push(toPoint(cell % W, (cell - (cell % W)) / W, g));
    first = cur;
    cur = came[cur];
  }
  path.reverse();
  return { path, from: starts[startOf[first]], to: term.port };
  }
}

/**
 * The grid is 10 px, ports are not: move the straight run leaving (or entering)
 * a port onto the port's exact coordinate so the line has no tiny jog.
 */
function snapRun(path: Point[], port: Port, atEnd: boolean): void {
  if (!path.length) return;
  const vertical = port.side === "top" || port.side === "bottom";
  const idx = (i: number) => (atEnd ? path.length - 1 - i : i);
  const ref = vertical ? path[idx(0)].x : path[idx(0)].y;
  for (let i = 0; i < path.length; i++) {
    const p = path[idx(i)];
    if ((vertical ? p.x : p.y) !== ref) break;
    if (vertical) p.x = port.point.x;
    else p.y = port.point.y;
  }
}

function cellCost(occ: Occupancy, k: number, dir: number, opts: RouteOptions): number {
  const horizontal = dir === 1 || dir === 3;
  const same = horizontal ? occ.h[k] : occ.v[k];
  const cross = horizontal ? occ.v[k] : occ.h[k];
  return same * opts.overlapPenalty + cross * opts.crossPenalty + occ.near[k];
}

function fallback(a: Point, b: Point, from: Side): Point[] {
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
  const a = out[1];
  if (a.x !== start.x && a.y !== start.y) out.splice(1, 0, { x: start.x, y: a.y });
  const z = out[out.length - 2];
  if (z.x !== end.x && z.y !== end.y) out.splice(out.length - 1, 0, { x: end.x, y: z.y });
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
    e.waypoints = simplifyPath([startPort, { x: startPort.x, y: midY }, { x: endPort.x, y: midY }, endPort]);
  }
}

function participantAsNode(model: BpmnModel, id: string): FlowNode | undefined {
  const p = model.participants[id];
  if (!p) return undefined;
  return { id: p.id, type: "task", parent: "", bounds: p.bounds } as FlowNode;
}
