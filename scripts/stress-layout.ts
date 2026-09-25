/**
 * Layout stress test: generates thousands of random but realistic processes
 * (the kind of Graph IR an LLM returns), lays each out and measures it.
 * No API key involved — layout runs entirely locally.
 *
 *   npx vite-node scripts/stress-layout.ts [count=1000] [seed=1] [--dump dir]
 *
 * Structured processes: sequences, nested XOR/AND/OR blocks, event-based
 * choices, rework loops, early end events, 0–6 lanes.
 * Unstructured processes (every 5th): additional cross-links between branches,
 * as LLMs sometimes produce ("goto" jumps).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { measureLayout } from "../src/core";
import { randomProcess, setSeed } from "../test/fixtures/random-process";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const COUNT = Number(args[0] ?? 1000);
setSeed(Number(args[1] ?? 1));
const dumpDir = process.argv.includes("--dump") ? process.argv[process.argv.indexOf("--dump") + 1] : undefined;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });


// ---------------------------------------------------------------------------

const hard = ["overlaps", "shapeHits", "outsidePool", "nodeOverlaps", "diagonals"] as const;
const stats = {
  cases: 0,
  withCrossings: 0,
  crossings: 0,
  bundles: 0,
  labelCollisions: 0,
  hardFail: Object.fromEntries(hard.map((k) => [k, 0])) as Record<(typeof hard)[number], number>,
  errors: 0,
  maxMs: 0,
  totalMs: 0,
  nodes: 0,
};
const failures: { i: number; unstructured: boolean; m: unknown }[] = [];

for (let i = 0; i < COUNT; i++) {
  const unstructured = i % 5 === 4;
  const ir = randomProcess(3 + (i * 7919) % 38, unstructured);
  let model;
  const t0 = performance.now();
  try {
    model = mapGraphToModel(sanitizeGraphIR(ir).ir).model;
  } catch (err) {
    stats.errors++;
    failures.push({ i, unstructured, m: String(err) });
    if (dumpDir) writeFileSync(`${dumpDir}/error-${i}.json`, JSON.stringify(ir));
    continue;
  }
  const ms = performance.now() - t0;
  stats.maxMs = Math.max(stats.maxMs, ms);
  stats.totalMs += ms;
  stats.nodes += Object.keys(model.nodes).length;
  const m = measureLayout(model);
  stats.cases++;
  stats.crossings += m.crossings;
  if (m.crossings) stats.withCrossings++;
  stats.bundles += m.bundles;
  stats.labelCollisions += m.labelCollisions;
  let bad = false;
  for (const k of hard) if (m[k]) (stats.hardFail[k]++, (bad = true));
  if (bad || m.crossings) {
    failures.push({ i, unstructured, m });
    if (dumpDir) writeFileSync(`${dumpDir}/case-${i}.json`, JSON.stringify(ir));
  }
}

console.log(JSON.stringify({ ...stats, avgMs: Math.round(stats.totalMs / Math.max(1, stats.cases)), avgNodes: Math.round(stats.nodes / Math.max(1, stats.cases)) }, null, 1));
console.log("first failures:", JSON.stringify(failures.slice(0, 8)));
