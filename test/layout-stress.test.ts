import { describe, expect, it } from "vitest";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { measureLayout } from "../src/core";
import { __layeredInternals as I } from "../src/core/layout/layered";
import { randomProcess, setSeed } from "./fixtures/random-process";

/**
 * Property tests on random but realistic processes (nested XOR/AND/OR,
 * event-based choices, loops, early ends, 0–6 lanes, cross-links).
 * scripts/stress-layout.ts runs the same checks on 10 000 processes.
 */
describe("layout stress (random processes)", () => {
  it("never produces overlapping flows, flows through shapes or outside the pool, diagonals or overlapping shapes", () => {
    setSeed(20260925);
    for (let i = 0; i < 120; i++) {
      const ir = randomProcess(3 + ((i * 7919) % 30), i % 5 === 4);
      const { model } = mapGraphToModel(sanitizeGraphIR(ir).ir);
      const m = measureLayout(model);
      const ctx = `case ${i}: ${JSON.stringify(m)}`;
      expect(m.overlaps, ctx).toBe(0);
      expect(m.shapeHits, ctx).toBe(0);
      expect(m.outsidePool, ctx).toBe(0);
      expect(m.diagonals, ctx).toBe(0);
      expect(m.nodeOverlaps, ctx).toBe(0);
    }
  }, 120_000);

  it("orders nodes with the provably minimal number of crossings on small processes", () => {
    setSeed(7);
    const perms = <T,>(a: T[]): T[][] =>
      a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
    let tested = 0;
    for (let i = 0; i < 150; i++) {
      const { model } = mapGraphToModel(sanitizeGraphIR(randomProcess(3 + (i % 9), i % 5 === 4)).ir);
      const { L, nodes, laneIdx } = I.prepare(model, model.rootProcessId);
      const options = L.ranks.map((rk) => perms(rk).filter((p) => p.every((id, k) => k === 0 || laneIdx(p[k - 1]) <= laneIdx(id))));
      if (options.reduce((acc, o) => acc * o.length, 1) > 50_000) continue;
      let best = Infinity;
      const cur = L.ranks.map((rk) => rk);
      const rec = (r: number) => {
        if (best === 0) return;
        if (r === options.length) {
          L.ranks = [...cur];
          best = Math.min(best, I.total(L));
          return;
        }
        for (const o of options[r]) {
          cur[r] = o;
          rec(r + 1);
        }
      };
      rec(0);
      I.orderRanksMultiStart(L, nodes, laneIdx, 12);
      expect(I.total(L), `case ${i}`).toBe(best);
      tested++;
    }
    expect(tested).toBeGreaterThan(100);
  }, 120_000);
});
