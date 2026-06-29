import { Bounds, Point } from "../model/types";

export type Side = "top" | "right" | "bottom" | "left";

export function center(b: Bounds): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export function pointOnSide(b: Bounds, side: Side, frac = 0.5): Point {
  switch (side) {
    case "top":
      return { x: b.x + b.width * frac, y: b.y };
    case "bottom":
      return { x: b.x + b.width * frac, y: b.y + b.height };
    case "left":
      return { x: b.x, y: b.y + b.height * frac };
    case "right":
      return { x: b.x + b.width, y: b.y + b.height * frac };
  }
}

export function inflate(b: Bounds, m: number): Bounds {
  return { x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m };
}

export function rectsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function pointInRect(p: Point, b: Bounds): boolean {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

/** Does an axis-aligned segment cross a rectangle interior? */
export function segmentIntersectsRect(a: Point, b: Point, r: Bounds): boolean {
  // Bounding box reject.
  const minX = Math.min(a.x, b.x),
    maxX = Math.max(a.x, b.x),
    minY = Math.min(a.y, b.y),
    maxY = Math.max(a.y, b.y);
  if (maxX <= r.x || minX >= r.x + r.width || maxY <= r.y || minY >= r.y + r.height) {
    return false;
  }
  return true;
}

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Collapse collinear interior points of an orthogonal polyline. */
export function simplifyPath(points: Point[]): Point[] {
  if (points.length <= 2) return points.slice();
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const collinearH = prev.y === cur.y && cur.y === next.y;
    const collinearV = prev.x === cur.x && cur.x === next.x;
    if (!collinearH && !collinearV) out.push(cur);
  }
  out.push(points[points.length - 1]);
  // dedupe consecutive identical points
  return out.filter((p, i) => i === 0 || p.x !== out[i - 1].x || p.y !== out[i - 1].y);
}

/** Count crossings between two orthogonal polylines (segment intersections). */
export function countCrossings(a: Point[], b: Point[]): number {
  let n = 0;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segIntersect(a[i], a[i + 1], b[j], b[j + 1])) n++;
    }
  }
  return n;
}

function segIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = dir(p3, p4, p1);
  const d2 = dir(p3, p4, p2);
  const d3 = dir(p1, p2, p3);
  const d4 = dir(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}
function dir(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
