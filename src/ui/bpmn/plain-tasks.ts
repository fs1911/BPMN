import BaseRenderer from "diagram-js/lib/draw/BaseRenderer";
import type Modeler from "bpmn-js/lib/Modeler";
import type { ElementLike, ShapeLike } from "diagram-js/lib/core/Types";

/**
 * "Aufgabentypen anzeigen" switch. When off, user/send/service/… tasks are
 * drawn like a plain task — no person, envelope or gear icon — as is usual in
 * process maps read by business people (Signavio templates, Q.wiki). Only the
 * drawing changes: the task type stays in the model, the process description
 * and the BPMN export. Loop/multi-instance markers stay visible.
 */

const TYPED_TASKS = new Set([
  "bpmn:UserTask",
  "bpmn:ManualTask",
  "bpmn:SendTask",
  "bpmn:ReceiveTask",
  "bpmn:ServiceTask",
  "bpmn:ScriptTask",
  "bpmn:BusinessRuleTask",
]);

interface Shape {
  type?: string;
  labelTarget?: unknown;
}

interface DrawingRenderer {
  handlers: Record<string, (parent: SVGElement, element: ShapeLike) => SVGElement>;
  getShapePath(element: ShapeLike): string;
}

class PlainTaskRenderer extends BaseRenderer {
  static $inject = ["eventBus", "bpmnRenderer"];
  enabled = true;

  constructor(
    eventBus: unknown,
    private readonly bpmnRenderer: DrawingRenderer,
  ) {
    // Above the BPMN renderer (1000) so it takes over typed tasks.
    super(eventBus as never, 1500);
  }

  canRender(element: ElementLike): boolean {
    const el = element as Shape;
    return this.enabled && TYPED_TASKS.has(el.type ?? "") && !el.labelTarget;
  }

  drawShape(parent: SVGElement, element: ShapeLike): SVGElement {
    return this.bpmnRenderer.handlers["bpmn:Task"](parent, element);
  }

  getShapePath(element: ShapeLike): string {
    return this.bpmnRenderer.getShapePath(element);
  }
}

export const plainTasksModule = {
  __init__: ["plainTaskRenderer"],
  plainTaskRenderer: ["type", PlainTaskRenderer],
};

/** Switch the icons on/off and redraw the affected tasks. */
export function setShowTaskTypes(modeler: Modeler, show: boolean): void {
  const renderer = modeler.get<PlainTaskRenderer>("plainTaskRenderer");
  if (renderer.enabled === !show) return;
  renderer.enabled = !show;
  const registry = modeler.get<{ getAll(): (Shape & { waypoints?: unknown })[]; getGraphics(e: unknown): SVGElement }>("elementRegistry");
  const graphics = modeler.get<{ update(kind: string, element: unknown, gfx: SVGElement): void }>("graphicsFactory");
  for (const el of registry.getAll()) {
    if (TYPED_TASKS.has(el.type ?? "") && !el.labelTarget) graphics.update("shape", el, registry.getGraphics(el));
  }
}

const STORAGE_KEY = "flowcraft.showTaskTypes";

/** Per-viewer preference; default off. Storage may be unavailable. */
export function loadShowTaskTypes(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowTaskTypes(show: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, show ? "1" : "0");
  } catch {
    /* preference just isn't remembered */
  }
}
