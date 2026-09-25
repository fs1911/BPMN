import { BpmnModel, Bounds, FlowElementType, isEvent, isGateway } from "../model";
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
    const cx = n.bounds.x + n.bounds.width / 2;
    const candidates: Bounds[] = [
      { x: cx - w / 2, y: n.bounds.y + n.bounds.height + 4, width: w, height: h }, // below
      { x: cx - w / 2, y: n.bounds.y - h - 4, width: w, height: h }, // above
      { x: n.bounds.x + n.bounds.width + 6, y: n.bounds.y + n.bounds.height / 2 - h / 2, width: w, height: h }, // right
      { x: n.bounds.x - w - 6, y: n.bounds.y + n.bounds.height / 2 - h / 2, width: w, height: h }, // left
      { x: n.bounds.x + n.bounds.width + 4, y: n.bounds.y + n.bounds.height + 2, width: w, height: h }, // below right
      { x: n.bounds.x - w - 4, y: n.bounds.y + n.bounds.height + 2, width: w, height: h }, // below left
      { x: n.bounds.x + n.bounds.width + 4, y: n.bounds.y - h - 2, width: w, height: h }, // above right
      { x: n.bounds.x - w - 4, y: n.bounds.y - h - 2, width: w, height: h }, // above left
    ];
    for (let k = 1; k <= 4; k++) {
      candidates.push({ x: cx - w / 2, y: n.bounds.y + n.bounds.height + 4 + k * 16, width: w, height: h });
    }
    const box = candidates.find((c) => !collides(c, obstacles())) ?? candidates[0];
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
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (len < 16) continue;
      if (Math.abs(a.y - b.y) < 1) {
        const dir = Math.sign(b.x - a.x);
        const x = dir > 0 ? a.x + 6 : a.x - 6 - w;
        candidates.push({ x, y: a.y - h - 2, width: w, height: h }, { x, y: a.y + 3, width: w, height: h });
      } else {
        const dir = Math.sign(b.y - a.y);
        const y = dir > 0 ? a.y + 4 : a.y - 4 - h;
        candidates.push({ x: a.x + 4, y, width: w, height: h }, { x: a.x - w - 4, y, width: w, height: h });
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
    const box = candidates.find((c) => !collides(c, obstacles(e.id))) ?? candidates[0];
    e.labelBounds = box;
    placed.push(box);
  }
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
