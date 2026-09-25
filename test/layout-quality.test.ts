import { describe, expect, it } from "vitest";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { measureLayout, rerouteOnly } from "../src/core";
import { CORPUS } from "./fixtures/processes";

/**
 * Layout quality gate on a corpus of realistic LLM-style processes (lanes,
 * cross-lane loops, parallel/inclusive/event-based gateways, several ends).
 * Numbers are objective (see src/core/layout/metrics.ts); a regression in any
 * of the hard criteria fails the build.
 */
describe("layout quality (corpus)", () => {
  for (const [name, ir] of Object.entries(CORPUS)) {
    it(`${name}: no crossings, overlaps, shape hits or flows outside the pool`, () => {
      const { model } = mapGraphToModel(sanitizeGraphIR(ir).ir);
      const m = measureLayout(model);
      expect(m.crossings).toBe(0);
      expect(m.overlaps).toBe(0);
      expect(m.shapeHits).toBe(0);
      expect(m.outsidePool).toBe(0);
      expect(m.nodeOverlaps).toBe(0);
      expect(m.diagonals).toBe(0);
      // bundles = branches sharing one gateway corner as a trunk (standard notation)
      expect(m.bundles).toBeLessThanOrEqual(6);
      expect(m.labelCollisions).toBeLessThanOrEqual(1);
      // few bends: ~1 per flow on average (a loop alone needs 3–4)
      expect(m.bends).toBeLessThanOrEqual(Math.ceil(Object.keys(model.edges).length * 1.3));
    });
  }

  it("re-routing a manually nudged diagram stays overlap-free and inside the pool", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const ir of Object.values(CORPUS)) {
      const { model } = mapGraphToModel(sanitizeGraphIR(ir).ir);
      for (const n of Object.values(model.nodes)) {
        n.bounds.x += Math.round((rnd() - 0.5) * 80);
        n.bounds.y += Math.round((rnd() - 0.5) * 30);
      }
      rerouteOnly(model, model.rootProcessId);
      const m = measureLayout(model);
      expect(m.overlaps).toBe(0);
      expect(m.shapeHits).toBe(0);
      expect(m.outsidePool).toBe(0);
      expect(m.diagonals).toBe(0);
      expect(m.crossings).toBeLessThanOrEqual(1);
    }
  });
});
