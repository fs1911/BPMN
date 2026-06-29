import { describe, expect, it } from "vitest";
import { routeScope } from "../src/core/routing/router";
import { autoLayout } from "../src/core/layout";
import { segmentIntersectsRect } from "../src/core/geometry/geometry";
import { createEdge, createNode, emptyModel, resetIdCounter } from "../src/core/model";
import { buildSampleProcess } from "./helpers";

function isOrthogonal(wps: { x: number; y: number }[]): boolean {
  for (let i = 0; i < wps.length - 1; i++) {
    if (wps[i].x !== wps[i + 1].x && wps[i].y !== wps[i + 1].y) return false;
  }
  return true;
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
    const channelYs = backs.map((b) => Math.max(...b.waypoints!.map((p) => p.y)));
    expect(channelYs[0]).not.toBe(channelYs[1]);
  });
});
