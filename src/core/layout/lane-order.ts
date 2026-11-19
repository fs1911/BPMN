import { BpmnModel } from "../model";

/**
 * Order of the lanes of a new diagram: every sequence flow from one lane to
 * another runs through all lanes in between — through their flows. The order
 * with the smallest total distance (lanes crossed, weighted by the flows) is
 * proposed; ties keep the given order. Exhaustive up to 7 lanes, otherwise the
 * given order stays.
 */
export function proposeLaneOrder(model: BpmnModel, scope = model.rootProcessId): string[] | undefined {
  const lanes = model.processes[scope]?.lanes ?? [];
  if (lanes.length < 3 || lanes.length > 7) return undefined;
  const laneOf: Record<string, string> = {};
  for (const l of lanes) for (const n of model.lanes[l].flowNodeRefs) laneOf[n] = l;
  // flows between two lanes, and how much is going on in each lane (what a crossing line would cut)
  const pairs = new Map<string, number>();
  const busy: Record<string, number> = Object.fromEntries(lanes.map((l) => [l, 0]));
  for (const e of Object.values(model.edges)) {
    if (e.type !== "sequenceFlow") continue;
    const a = laneOf[e.source];
    const b = laneOf[e.target];
    if (!a || !b) continue;
    if (a === b) busy[a] += 1;
    else {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const cost = (order: string[]) => {
    const pos = Object.fromEntries(order.map((l, i) => [l, i]));
    let c = 0;
    for (const [key, n] of pairs) {
      const [a, b] = key.split("|");
      const [lo, hi] = [Math.min(pos[a], pos[b]), Math.max(pos[a], pos[b])];
      // one per lane boundary, plus the work in every lane jumped over
      c += n * (hi - lo);
      for (let i = lo + 1; i < hi; i++) c += n * (1 + busy[order[i]]);
    }
    return c;
  };
  let best = { order: lanes, cost: cost(lanes) };
  const permute = (prefix: string[], rest: string[]) => {
    if (!rest.length) {
      const c = cost(prefix);
      if (c < best.cost) best = { order: prefix, cost: c };
      return;
    }
    rest.forEach((l, i) => permute([...prefix, l], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  permute([], lanes);
  return best.order === lanes ? undefined : best.order;
}
