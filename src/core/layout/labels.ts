import { BpmnModel, Bounds, FlowElementType, Point, isEvent, isGateway } from "../model";
import { rectsOverlap } from "../geometry/geometry";

/**
 * Greedy label placement that keeps labels off shapes, edges and each other.
 *
 * External-label elements (events, gateways, data references) and named flows
 * get an explicit DI label box. For each label we try a ring of candidate
 * positions and pick the first that does not collide with shapes, routed edge
 * segments or already-placed labels — the readability win that off-the-shelf
 * auto-placement misses on dense diagrams.
 */

function hasExternalLabel(type: FlowElementType): boolean {
  return isEvent(type) || isGateway(type) || type === "dataObjectReference" || type === "dataStoreReference";
}

/** Rough text box size for a label (bpmn-js wraps ~ at 100px). */
function labelSize(name: string): { w: number; h: number } {
  const max = 100;
  const charW = 6.2;
  const oneLine = name.length * charW;
  const w = Math.min(max, Math.max(40, oneLine));
  const lines = Math.max(1, Math.ceil(oneLine / w));
  return { w: Math.round(w), h: 14 * lines + 4 };
}

function collides(box: Bounds, obstacles: Bounds[], pad = 2): boolean {
  const b = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  return obstacles.some((o) => rectsOverlap(b, o));
}

/** Thin bounding boxes for each segment of a routed polyline (as obstacles). */
function edgeSegmentBoxes(model: BpmnModel): { edge: string; box: Bounds }[] {
  const boxes: { edge: string; box: Bounds }[] = [];
  for (const e of Object.values(model.edges)) {
    const wps = e.waypoints;
    if (!wps || wps.length < 2) continue;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      boxes.push({
        edge: e.id,
        box: {
          x: Math.min(a.x, b.x) - 1,
          y: Math.min(a.y, b.y) - 1,
          width: Math.abs(a.x - b.x) + 2,
          height: Math.abs(a.y - b.y) + 2,
        },
      });
    }
  }
  return boxes;
}

export function placeLabels(model: BpmnModel, scope: string): void {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope);
  // Shapes plus the name strips of pool and lanes (bpmn-js draws their labels there).
  const headerStrips: Bounds[] = [
    ...Object.values(model.participants).map((p) => ({ x: p.bounds.x, y: p.bounds.y, width: 30, height: p.bounds.height })),
    ...Object.values(model.lanes).map((l) => ({ x: l.bounds.x, y: l.bounds.y, width: 30, height: l.bounds.height })),
  ];
  const shapeObstacles: Bounds[] = [...nodes.map((n) => n.bounds), ...headerStrips];
  const segs = edgeSegmentBoxes(model);
  const placed: Bounds[] = [];
  const obstacles = (exceptEdge?: string) => [
    ...shapeObstacles,
    ...segs.filter((s) => s.edge !== exceptEdge).map((s) => s.box),
    ...placed,
  ];

  // 1) External node labels.
  for (const n of nodes) {
    if (!n.name || !hasExternalLabel(n.type)) {
      n.labelBounds = undefined;
      continue;
    }
    const { w, h } = labelSize(n.name);
    const b = n.bounds;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const candidates: Bounds[] = [];
    for (const d of [4, 16, 30]) {
      candidates.push(
        { x: cx - w / 2, y: b.y + b.height + d, width: w, height: h }, // below
        { x: cx - w / 2, y: b.y - h - d, width: w, height: h }, // above
        { x: b.x + b.width + d + 2, y: cy - h / 2, width: w, height: h }, // right
        { x: b.x - w - d - 2, y: cy - h / 2, width: w, height: h }, // left
        // beside a vertical trunk leaving the top/bottom corner
        { x: cx + 5, y: b.y + b.height + d - 2, width: w, height: h }, // below, right of trunk
        { x: cx - w - 5, y: b.y + b.height + d - 2, width: w, height: h }, // below, left of trunk
        { x: cx + 5, y: b.y - h - d + 2, width: w, height: h }, // above, right of trunk
        { x: cx - w - 5, y: b.y - h - d + 2, width: w, height: h }, // above, left of trunk
        // diagonal corners
        { x: b.x + b.width + d, y: b.y + b.height + d / 2, width: w, height: h },
        { x: b.x - w - d, y: b.y + b.height + d / 2, width: w, height: h },
        { x: b.x + b.width + d, y: b.y - h - d / 2, width: w, height: h },
        { x: b.x - w - d, y: b.y - h - d / 2, width: w, height: h },
      );
    }
    const obs = obstacles();
    const box = candidates.find((c) => !collides(c, obs)) ?? leastOverlap(candidates, obs);
    n.labelBounds = box;
    placed.push(box);
  }

  // 2) Edge labels: next to the first segment(s), right after the source —
  //    where a reader looks for a gateway's branch condition.
  for (const e of Object.values(model.edges)) {
    const wps = e.waypoints;
    if (!e.name || !wps || wps.length < 2) {
      e.labelBounds = undefined;
      continue;
    }
    const { w, h } = labelSize(e.name);
    const candidates: Bounds[] = [];
    // Segments shared with a sibling branch (a common trunk out of the
    // gateway) would make "ja"/"nein" ambiguous: label where the branch
    // splits off, and fall back to the trunk only if nothing else fits.
    const siblings = Object.values(model.edges).filter((o) => o.id !== e.id && o.source === e.source && o.waypoints);
    const shared = (a: Point, b: Point) => siblings.some((o) => o.waypoints!.some((p, j) => j > 0 && overlaps(a, b, o.waypoints![j - 1], p)));
    const order = [...wps.keys()].slice(0, -1);
    order.sort((i, j) => Number(shared(wps[i], wps[i + 1])) - Number(shared(wps[j], wps[j + 1])));
    // Along each segment (start first — where a reader looks for a branch
    // condition — then middle and end), on both sides, near then farther.
    for (const i of order) {
      for (const gap of [3, 12]) {
        const a = wps[i];
        const b = wps[i + 1];
        const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (len < 16) continue;
        // Right after the split point a label still reads as belonging to
        // the trunk: move it along the branch.
        const afterTrunk = i > 0 && shared(wps[i - 1], a);
        if (Math.abs(a.y - b.y) < 1) {
          const dir = Math.sign(b.x - a.x);
          const lo = Math.min(a.x, b.x);
          const hi = Math.max(a.x, b.x);
          const xs = [dir > 0 ? a.x + 6 : a.x - 6 - w, (a.x + b.x) / 2 - w / 2, dir > 0 ? b.x - 6 - w : b.x + 6].slice(afterTrunk ? 1 : 0).filter((x) => x >= lo - w && x <= hi);
          for (const x of xs) candidates.push({ x, y: a.y - h - gap + 1, width: w, height: h }, { x, y: a.y + gap, width: w, height: h });
        } else {
          const dir = Math.sign(b.y - a.y);
          const ys = [dir > 0 ? a.y + 4 : a.y - 4 - h, (a.y + b.y) / 2 - h / 2, dir > 0 ? b.y - 4 - h : b.y + 4].slice(afterTrunk ? 1 : 0);
          for (const y of ys) candidates.push({ x: a.x + gap + 1, y, width: w, height: h }, { x: a.x - w - gap - 1, y, width: w, height: h });
        }
      }
    }
    // Fallback: around the midpoint, increasingly far from the line.
    const mid = wps[Math.floor(wps.length / 2)];
    const prev = wps[Math.floor(wps.length / 2) - 1] ?? wps[0];
    const horizontal = Math.abs(mid.x - prev.x) >= Math.abs(mid.y - prev.y);
    const base = { x: (mid.x + prev.x) / 2 - w / 2, y: (mid.y + prev.y) / 2 - h / 2 };
    for (const d of [h, -h, 2 * h, -2 * h]) {
      candidates.push(horizontal ? { x: base.x, y: base.y + d, width: w, height: h } : { x: base.x + d + (d > 0 ? w / 2 : -w / 2), y: base.y, width: w, height: h });
    }
    const obs = obstacles(e.id);
    const box = candidates.find((c) => !collides(c, obs)) ?? leastOverlap(candidates, obs);
    e.labelBounds = box;
    placed.push(box);
  }
}

/** Two axis-parallel segments on the same line with a common stretch. */
function overlaps(a: Point, b: Point, c: Point, d: Point): boolean {
  const hor = (p: Point, q: Point) => Math.abs(p.y - q.y) < 1;
  if (hor(a, b) && hor(c, d) && Math.abs(a.y - c.y) < 1) {
    return Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > 4;
  }
  if (!hor(a, b) && !hor(c, d) && Math.abs(a.x - c.x) < 1) {
    return Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > 4;
  }
  return false;
}

/** When every candidate collides, take the one covering the least area. */
function leastOverlap(candidates: Bounds[], obstacles: Bounds[]): Bounds {
  let best = candidates[0];
  let bestA = Infinity;
  for (const c of candidates) {
    let a = 0;
    for (const o of obstacles) {
      const w = Math.min(c.x + c.width, o.x + o.width) - Math.max(c.x, o.x);
      const h = Math.min(c.y + c.height, o.y + o.height) - Math.max(c.y, o.y);
      if (w > 0 && h > 0) a += Math.max(w, 2) * Math.max(h, 2);
    }
    if (a < bestA) {
      bestA = a;
      best = c;
    }
  }
  return best;
}

/** Number of labels colliding with shapes, other labels or foreign flows. */
export function countLabelCollisions(model: BpmnModel, scope: string): number {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope);
  const segs = edgeSegmentBoxes(model);
  const labels: { owner: string; box: Bounds }[] = [
    ...nodes.filter((n) => n.labelBounds).map((n) => ({ owner: n.id, box: n.labelBounds! })),
    ...Object.values(model.edges).filter((e) => e.labelBounds).map((e) => ({ owner: e.id, box: e.labelBounds! })),
  ];
  let c = 0;
  labels.forEach((l, i) => {
    const others = [
      ...nodes.filter((n) => n.id !== l.owner).map((n) => n.bounds),
      ...segs.filter((s) => s.edge !== l.owner).map((s) => s.box),
      ...labels.filter((_, j) => j !== i).map((o) => o.box),
    ];
    if (collides(l.box, others, 0)) c++;
  });
  return c;
}
