import { describe, expect, it } from "vitest";
import { layoutScope, contentBounds } from "../src/core/layout/layered";
import { autoLayout } from "../src/core/layout";
import { buildAdjacency, createEdge, createNode, emptyModel, resetIdCounter } from "../src/core/model";
import { buildSampleProcess } from "./helpers";

describe("layered layout", () => {
  it("orders the main flow left to right and ranks start before end", () => {
    const m = buildSampleProcess();
    const res = layoutScope(m, "P");
    expect(res.rankOf["start"]).toBeLessThan(res.rankOf["check"]);
    expect(res.rankOf["check"]).toBeLessThan(res.rankOf["gw"]);
    expect(res.rankOf["gw"]).toBeLessThan(res.rankOf["end"]);
    expect(m.nodes["start"].bounds.x).toBeLessThan(m.nodes["end"].bounds.x);
  });

  it("classifies the rework edge as a back edge and excludes it from ranking", () => {
    const m = buildSampleProcess();
    const res = layoutScope(m, "P");
    const back = Object.values(m.edges).find((e) => e.name === "incomplete");
    expect(back?.isBackEdge).toBe(true);
    expect(res.backEdgeIds.has(back!.id)).toBe(true);
    // the loop target must NOT be pushed to a later rank than its consumer
    expect(res.rankOf["receive"]).toBeLessThan(res.rankOf["gw"]);
  });

  it("keeps nodes non-overlapping after layout", () => {
    const m = buildSampleProcess();
    autoLayout(m, "P");
    const nodes = Object.values(m.nodes);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].bounds;
        const b = nodes[j].bounds;
        const overlap =
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap, `${nodes[i].id} overlaps ${nodes[j].id}`).toBe(false);
      }
    }
  });

  it("places swimlane nodes inside their lane band", () => {
    resetIdCounter();
    const m = emptyModel({ processId: "P" });
    const laneA = { id: "LA", name: "Clerk", parent: "P", bounds: { x: 0, y: 0, width: 0, height: 0 }, flowNodeRefs: [] as string[] };
    const laneB = { id: "LB", name: "Manager", parent: "P", bounds: { x: 0, y: 0, width: 0, height: 0 }, flowNodeRefs: [] as string[] };
    m.lanes = { LA: laneA, LB: laneB };
    m.processes["P"].lanes = ["LA", "LB"];
    const s = createNode(m, "startEvent", { id: "s", lane: "LA" });
    const t1 = createNode(m, "userTask", { id: "t1", name: "Prepare", lane: "LA" });
    const t2 = createNode(m, "userTask", { id: "t2", name: "Approve", lane: "LB" });
    const e = createNode(m, "endEvent", { id: "e", lane: "LB" });
    createEdge(m, "sequenceFlow", s.id, t1.id);
    createEdge(m, "sequenceFlow", t1.id, t2.id);
    createEdge(m, "sequenceFlow", t2.id, e.id);

    autoLayout(m, "P");
    const inBand = (nodeId: string, laneId: string) => {
      const n = m.nodes[nodeId].bounds;
      const l = m.lanes[laneId].bounds;
      return n.y >= l.y - 1 && n.y + n.height <= l.y + l.height + 1;
    };
    expect(inBand("t1", "LA")).toBe(true);
    expect(inBand("t2", "LB")).toBe(true);
    // lanes must not overlap vertically
    expect(m.lanes["LA"].bounds.y + m.lanes["LA"].bounds.height).toBeLessThanOrEqual(m.lanes["LB"].bounds.y + 1);
  });

  it("is deterministic across runs", () => {
    const a = buildSampleProcess();
    const b = buildSampleProcess();
    autoLayout(a, "P");
    autoLayout(b, "P");
    expect(a.nodes["check"].bounds).toEqual(b.nodes["check"].bounds);
  });

  it("places external labels without overlapping shapes", () => {
    const m = buildSampleProcess();
    autoLayout(m, "P");
    const shapes = Object.values(m.nodes).map((n) => n.bounds);
    const overlap = (a: any, b: any) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    for (const n of Object.values(m.nodes)) {
      if (!n.labelBounds) continue;
      for (const s of shapes) {
        if (s === n.bounds) continue;
        expect(overlap(n.labelBounds, s), `label of ${n.id} overlaps a shape`).toBe(false);
      }
    }
  });

  it("reports content bounds", () => {
    const m = buildSampleProcess();
    autoLayout(m, "P");
    const cb = contentBounds(m, "P");
    expect(cb.width).toBeGreaterThan(0);
    expect(cb.height).toBeGreaterThan(0);
    void buildAdjacency;
  });
});
