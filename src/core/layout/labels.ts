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
function edgeSegmentBoxes(model: BpmnModel): Bounds[] {
  const boxes: Bounds[] = [];
  for (const e of Object.values(model.edges)) {
    const wps = e.waypoints;
    if (!wps || wps.length < 2) continue;
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i];
      const b = wps[i + 1];
      boxes.push({
        x: Math.min(a.x, b.x) - 1,
        y: Math.min(a.y, b.y) - 1,
        width: Math.abs(a.x - b.x) + 2,
        height: Math.abs(a.y - b.y) + 2,
      });
    }
  }
  return boxes;
}

export function placeLabels(model: BpmnModel, scope: string): void {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope);
  const shapeObstacles: Bounds[] = nodes.map((n) => n.bounds);
  const edgeObstacles = edgeSegmentBoxes(model);
  const placed: Bounds[] = [];
  const obstacles = () => [...shapeObstacles, ...edgeObstacles, ...placed];

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
      { x: n.bounds.x + n.bounds.width + 6, y: n.bounds.y + n.bounds.height / 2 - h / 2, width: w, height: h }, // right (preferred over above to avoid clipping at the pool top)
      { x: cx - w / 2, y: n.bounds.y - h - 4, width: w, height: h }, // above
      { x: n.bounds.x - w - 6, y: n.bounds.y + n.bounds.height / 2 - h / 2, width: w, height: h }, // left
    ];
    // plus downward-shifted fallbacks below the shape
    for (let k = 1; k <= 4; k++) {
      candidates.push({ x: cx - w / 2, y: n.bounds.y + n.bounds.height + 4 + k * 16, width: w, height: h });
    }
    const box = candidates.find((c) => !collides(c, obstacles())) ?? candidates[0];
    n.labelBounds = box;
    placed.push(box);
  }

  // 2) Edge labels.
  for (const e of Object.values(model.edges)) {
    const wps = e.waypoints;
    if (!e.name || !wps || wps.length < 2) {
      e.labelBounds = undefined;
      continue;
    }
    const mid = wps[Math.floor(wps.length / 2)];
    const prev = wps[Math.floor(wps.length / 2) - 1] ?? wps[0];
    const horizontal = Math.abs(mid.x - prev.x) >= Math.abs(mid.y - prev.y);
    const { w, h } = labelSize(e.name);
    const base = { x: mid.x - w / 2, y: mid.y - h / 2 };
    // offset perpendicular to the segment, both directions, increasing distance
    const candidates: Bounds[] = [];
    for (const d of [12, -12, 24, -24, 36, -36]) {
      candidates.push(
        horizontal
          ? { x: base.x, y: base.y + d, width: w, height: h }
          : { x: base.x + d, y: base.y, width: w, height: h },
      );
    }
    candidates.push({ ...base, width: w, height: h });
    const box = candidates.find((c) => !collides(c, obstacles())) ?? candidates[candidates.length - 1];
    e.labelBounds = box;
    placed.push(box);
  }
}
