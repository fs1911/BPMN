import { describe, expect, it } from "vitest";
import { routeScope } from "../src/core/routing/router";
import { autoLayout } from "../src/core/layout";
import { segmentIntersectsRect } from "../src/core/geometry/geometry";
import { createEdge, createNode, emptyModel, resetIdCounter } from "../src/core/model";
import { countCrossings } from "../src/core/geometry/geometry";
import { buildSampleProcess } from "./helpers";

function isOrthogonal(wps: { x: number; y: number }[]): boolean {
  for (let i = 0; i < wps.length - 1; i++) {
    if (wps[i].x !== wps[i + 1].x && wps[i].y !== wps[i + 1].y) return false;
  }
  return true;
}

type P = { x: number; y: number };
/** Length of the longest collinear overlap between segments of two polylines. */
function collinearOverlap(a: P[], b: P[]): number {
  let max = 0;
  const segs = (w: P[]) => w.slice(0, -1).map((p, i) => [p, w[i + 1]] as [P, P]);
  for (const [a1, a2] of segs(a)) {
    for (const [b1, b2] of segs(b)) {
      // horizontal overlap on the same y
      if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
        const ov = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x));
        max = Math.max(max, ov);
      }
      // vertical overlap on the same x
      if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
        const ov = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y));
        max = Math.max(max, ov);
      }
    }
  }
  return max;
}

describe("orthogonal router", () => {
  it("produces orthogonal waypoints for every flow", () => {
    const m = buildSampleProcess();
    autoLayout(m, "P");
    for (const e of Object.values(m.edges)) {
      expect(e.waypoints && e.waypoints.length >= 2).toBe(true);
      expect(isOrthogonal(e.waypoints!), `edge ${e.id} not orthogonal`).toBe(true);
    }
  });

  it("routes around an obstacle instead of through it", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    // A --- (obstacle B in the straight line) --- C
    createNode(m, "task", { id: "A", name: "A", bounds: { x: 0, y: 100, width: 80, height: 60 } });
    const b = createNode(m, "task", { id: "B", name: "B", bounds: { x: 200, y: 90, width: 100, height: 80 } });
    createNode(m, "task", { id: "C", name: "C", bounds: { x: 460, y: 100, width: 80, height: 60 } });
    const e = createEdge(m, "sequenceFlow", "A", "C");
    routeScope(m, "P");
    expect(e.waypoints!.length).toBeGreaterThan(2);
    // no segment may pass through B's interior
    const wps = e.waypoints!;
    for (let i = 0; i < wps.length - 1; i++) {
      expect(segmentIntersectsRect(wps[i], wps[i + 1], b.bounds)).toBe(false);
    }
  });

  it("fans multiple flows out of a gateway from distinct points", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "exclusiveGateway", { id: "G", bounds: { x: 200, y: 200, width: 50, height: 50 } });
    createNode(m, "task", { id: "X", bounds: { x: 400, y: 100, width: 100, height: 60 } });
    createNode(m, "task", { id: "Y", bounds: { x: 400, y: 320, width: 100, height: 60 } });
    const e1 = createEdge(m, "sequenceFlow", "G", "X");
    const e2 = createEdge(m, "sequenceFlow", "G", "Y");
    routeScope(m, "P");
    const s1 = e1.waypoints![0];
    const s2 = e2.waypoints![0];
    expect(s1.x !== s2.x || s1.y !== s2.y).toBe(true);
  });

  it("folds back edges into a channel below all content", () => {
    const m = buildSampleProcess();
    autoLayout(m, "P");
    const back = Object.values(m.edges).find((e) => e.isBackEdge)!;
    const contentBottom = Math.max(...Object.values(m.nodes).map((n) => n.bounds.y + n.bounds.height));
    const lowestY = Math.max(...back.waypoints!.map((p) => p.y));
    // the back edge must dip below the content to avoid the forward flow
    expect(lowestY).toBeGreaterThanOrEqual(contentBottom);
    expect(isOrthogonal(back.waypoints!)).toBe(true);
  });

  it("keeps crossings low for a planar split/join (crossing minimisation)", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "startEvent", { id: "s" });
    createNode(m, "parallelGateway", { id: "split" });
    createNode(m, "userTask", { id: "a", name: "A" });
    createNode(m, "userTask", { id: "b", name: "B" });
    createNode(m, "userTask", { id: "c", name: "C" });
    createNode(m, "parallelGateway", { id: "join" });
    createNode(m, "endEvent", { id: "e" });
    createEdge(m, "sequenceFlow", "s", "split");
    for (const x of ["a", "b", "c"]) createEdge(m, "sequenceFlow", "split", x);
    for (const x of ["a", "b", "c"]) createEdge(m, "sequenceFlow", x, "join");
    createEdge(m, "sequenceFlow", "join", "e");
    autoLayout(m, "P");
    const wps = Object.values(m.edges).map((e) => e.waypoints!).filter(Boolean);
    let crossings = 0;
    for (let i = 0; i < wps.length; i++)
      for (let j = i + 1; j < wps.length; j++) crossings += countCrossings(wps[i], wps[j]);
    // 8 edges through two gateways: heuristic router keeps crossings minimal.
    expect(crossings).toBeLessThanOrEqual(2);
  });

  it("keeps parallel flows on separate tracks (edge-aware routing)", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "startEvent", { id: "s" });
    createNode(m, "parallelGateway", { id: "split", name: "" });
    createNode(m, "userTask", { id: "a", name: "Task A" });
    createNode(m, "userTask", { id: "b", name: "Task B" });
    createNode(m, "userTask", { id: "c", name: "Task C" });
    createNode(m, "parallelGateway", { id: "join", name: "" });
    createNode(m, "endEvent", { id: "e" });
    createEdge(m, "sequenceFlow", "s", "split");
    createEdge(m, "sequenceFlow", "split", "a");
    createEdge(m, "sequenceFlow", "split", "b");
    createEdge(m, "sequenceFlow", "split", "c");
    createEdge(m, "sequenceFlow", "a", "join");
    createEdge(m, "sequenceFlow", "b", "join");
    createEdge(m, "sequenceFlow", "c", "join");
    createEdge(m, "sequenceFlow", "join", "e");
    autoLayout(m, "P");

    // No two distinct edges may share a long collinear overlapping segment.
    const edges = Object.values(m.edges).filter((e) => e.waypoints);
    let worst = 0;
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        worst = Math.max(worst, collinearOverlap(edges[i].waypoints!, edges[j].waypoints!));
      }
    }
    // allow a little shared stubbing near shared endpoints, but not a full track
    expect(worst).toBeLessThan(60);
  });

  it("separates multiple back edges into different channels", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    createNode(m, "startEvent", { id: "s" });
    createNode(m, "task", { id: "t1", name: "One" });
    createNode(m, "task", { id: "t2", name: "Two" });
    createNode(m, "exclusiveGateway", { id: "g", name: "Ok?" });
    createNode(m, "endEvent", { id: "e" });
    createEdge(m, "sequenceFlow", "s", "t1");
    createEdge(m, "sequenceFlow", "t1", "t2");
    createEdge(m, "sequenceFlow", "t2", "g");
    createEdge(m, "sequenceFlow", "g", "e", { name: "ok" });
    createEdge(m, "sequenceFlow", "g", "t1", { name: "back1" });
    createEdge(m, "sequenceFlow", "g", "t2", { name: "back2" });
    autoLayout(m, "P");
    const backs = Object.values(m.edges).filter((e) => e.isBackEdge);
    expect(backs.length).toBe(2);
    // the two loops must not run on top of each other
    expect(collinearOverlap(backs[0].waypoints!, backs[1].waypoints!)).toBeLessThan(60);
    // and both stay orthogonal
    for (const b of backs) expect(isOrthogonal(b.waypoints!)).toBe(true);
  });
});
