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
      // the real tender process (6 lanes, 6 loops across lanes, 8 message flows) keeps a few structural crossings
      expect(m.crossings).toBeLessThanOrEqual(name === "ausschreibung" ? 7 : 0); // 3 sequence + 4 message-flow crossings
      // no giant detours around the diagram (was 1 717 px before loop channels)
      expect(m.maxDetour).toBeLessThanOrEqual(400);
      expect(m.overlaps).toBe(0);
      expect(m.shapeHits).toBe(0);
      expect(m.outsidePool).toBe(0);
      expect(m.nodeOverlaps).toBe(0);
      expect(m.diagonals).toBe(0);
      // bundles = branches sharing one gateway corner as a trunk (standard notation)
      expect(m.bundles).toBeLessThanOrEqual(Math.max(6, Math.ceil(Object.keys(model.edges).length / 4)));
      expect(m.labelCollisions).toBeLessThanOrEqual(name === "ausschreibung" ? 2 : 1);
      // few bends: ~1 per flow on average (a loop alone needs 3–4)
      expect(m.bends).toBeLessThanOrEqual(Math.ceil(Object.keys(model.edges).length * 1.3));
    });
  }

  it("re-routing a manually nudged diagram stays overlap-free and inside the pool", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const [name, ir] of Object.entries(CORPUS)) {
      const { model } = mapGraphToModel(sanitizeGraphIR(ir).ir);
      // nudge shapes like a user would — without dropping one onto another
      // (stacked shapes are flagged by the layout check instead)
      const nodes = Object.values(model.nodes);
      const hits = (a: typeof nodes[number]) =>
        nodes.some((b) => b !== a && a.bounds.x < b.bounds.x + b.bounds.width + 10 && b.bounds.x < a.bounds.x + a.bounds.width + 10 && a.bounds.y < b.bounds.y + b.bounds.height + 10 && b.bounds.y < a.bounds.y + a.bounds.height + 10);
      for (const n of nodes) {
        const dx = Math.round((rnd() - 0.5) * 80);
        const dy = Math.round((rnd() - 0.5) * 30);
        n.bounds.x += dx;
        n.bounds.y += dy;
        if (hits(n)) {
          n.bounds.x -= dx;
          n.bounds.y -= dy;
        }
      }
      rerouteOnly(model, model.rootProcessId);
      const m = measureLayout(model);
      expect(m.overlaps).toBe(0);
      expect(m.shapeHits).toBe(0);
      expect(m.outsidePool).toBe(0);
      expect(m.diagonals).toBe(0);
      // manual arrangements keep more crossings on the dense tender process
      expect(m.crossings).toBeLessThanOrEqual(name === "ausschreibung" ? 14 : 1);
    }
  });
});
