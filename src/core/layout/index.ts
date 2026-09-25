import { BpmnModel, cloneModel } from "../model";
import { placeExternalPools, routeMessageFlows, routeScope, RouteOptions } from "../routing/router";
import { LayoutOptions, LayoutResult, contentBounds, fitLabelSizes, layoutScope } from "./layered";
import { placeLabels } from "./labels";
import { measureLayout } from "./metrics";

export * from "./layered";
export { placeLabels } from "./labels";
export { measureLayout } from "./metrics";
export type { LayoutMetrics } from "./metrics";

export interface AutoLayoutOptions {
  layout?: Partial<LayoutOptions>;
  routing?: Partial<RouteOptions>;
}

/**
 * Full automatic cleanup for a scope: layered placement with integrated
 * routing of forward flows, A* routing of loops, message flows and labels.
 *
 * When the scope has lanes, long cross-lane flows can run in either the source
 * or the target lane; both variants are computed and the one with the better
 * measured quality (crossings, overlaps, bends, length) wins. Deterministic.
 */
export function autoLayout(
  model: BpmnModel,
  scope = model.rootProcessId,
  opts: AutoLayoutOptions = {},
): LayoutResult {
  fitLabelSizes(model, scope);
  const hasLanes = (model.processes[scope]?.lanes.length ?? 0) > 0;
  const small = Object.keys(model.nodes).length <= 150;
  const edgePolicies: Array<"source" | "target"> = opts.layout?.longEdgeLane
    ? [opts.layout.longEdgeLane]
    : hasLanes && small
      ? ["source", "target"]
      : ["source"]; // very large diagrams: one variant keeps the layout responsive
  const loopModes: Array<LayoutOptions["loopMode"]> = opts.layout?.loopMode
    ? [opts.layout.loopMode]
    : small
      ? hasLanes
        ? ["channel-target", "channel-source", "router"]
        : ["channel-target", "router"]
      : ["channel-target"];

  // Every variant is laid out and measured; the best-scoring one wins.
  const variants = edgePolicies.flatMap((longEdgeLane) => loopModes.map((loopMode) => ({ longEdgeLane, loopMode })));
  let best: { model: BpmnModel; result: LayoutResult; score: number } | undefined;
  let hasBackEdges = true;
  for (const v of variants) {
    // loop modes only differ when there are loops
    if (!hasBackEdges && v.loopMode !== loopModes[0]) continue;
    const candidate = variants.length > 1 ? cloneModel(model) : model;
    const result = layoutScope(candidate, scope, { ...opts.layout, ...v });
    hasBackEdges = result.backEdgeIds.size > 0;
    // Forward flows (and channel loops) are routed by the layout; A* handles the rest.
    routeScope(candidate, scope, opts.routing, { keep: result.routed });
    const score = layoutScore(candidate, scope);
    if (!best || score < best.score) best = { model: candidate, result, score };
  }
  if (best!.model !== model) copyGeometry(best!.model, model);

  placeExternalPools(model, scope);
  routeMessageFlows(model);
  placeLabels(model, scope);
  return best!.result;
}

/**
 * Quality score (lower is better). Hard defects dominate; a crossing weighs
 * like a ~300 px detour — long lines around the whole diagram are at least as
 * hard to read as a crossing.
 */
export function layoutScore(model: BpmnModel, scope: string): number {
  const m = measureLayout(model, scope);
  return (
    10000 * (m.overlaps + m.shapeHits + m.nodeOverlaps + m.outsidePool) +
    300 * m.crossings +
    150 * m.bundles +
    20 * m.bends +
    m.detour +
    m.length / 20
  );
}

function copyGeometry(from: BpmnModel, to: BpmnModel): void {
  for (const [id, n] of Object.entries(from.nodes)) if (to.nodes[id]) to.nodes[id].bounds = { ...n.bounds };
  for (const [id, e] of Object.entries(from.edges)) {
    if (!to.edges[id]) continue;
    to.edges[id].waypoints = e.waypoints?.map((p) => ({ ...p }));
    to.edges[id].isBackEdge = e.isBackEdge;
  }
  for (const [id, l] of Object.entries(from.lanes)) if (to.lanes[id]) to.lanes[id].bounds = { ...l.bounds };
  for (const [id, p] of Object.entries(from.participants)) if (to.participants[id] && p.processRef) to.participants[id].bounds = { ...p.bounds };
}

/** Re-route only (flow cleanup) without moving any shape. */
export function rerouteOnly(model: BpmnModel, scope = model.rootProcessId, opts: AutoLayoutOptions = {}): void {
  routeScope(model, scope, opts.routing);
  routeMessageFlows(model);
  placeLabels(model, scope);
}

export { contentBounds };
