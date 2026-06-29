import { BpmnModel } from "../model";
import { routeMessageFlows, routeScope, RouteOptions } from "../routing/router";
import { LayoutOptions, LayoutResult, contentBounds, layoutScope } from "./layered";

export * from "./layered";

export interface AutoLayoutOptions {
  layout?: Partial<LayoutOptions>;
  routing?: Partial<RouteOptions>;
}

/**
 * Full automatic cleanup for a scope: layered placement, then orthogonal
 * routing of sequence flows (with dedicated back-edge channels), then message
 * flow routing. Deterministic given the same model.
 */
export function autoLayout(
  model: BpmnModel,
  scope = model.rootProcessId,
  opts: AutoLayoutOptions = {},
): LayoutResult {
  const result = layoutScope(model, scope, opts.layout);
  routeScope(model, scope, opts.routing);
  routeMessageFlows(model);
  return result;
}

/** Re-route only (flow cleanup) without moving any shape. */
export function rerouteOnly(model: BpmnModel, scope = model.rootProcessId, opts: AutoLayoutOptions = {}): void {
  routeScope(model, scope, opts.routing);
  routeMessageFlows(model);
}

export { contentBounds };
