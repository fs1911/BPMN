import type Modeler from "bpmn-js/lib/Modeler";
import {
  BpmnModel,
  autoLayout,
  createEdge,
  createNode,
  emptyModel,
  rerouteOnly,
} from "@core/index";
import { exportBpmn, importBpmn } from "@core/xml";

/**
 * Integration seam between the bpmn-js editor (rendering + manual modeling) and
 * the custom FlowCraft engine (AI generation, auto-layout/routing cleanup,
 * instruction updates, validation). bpmn-js owns the live diagram; the engine
 * operates on BPMN XML round-tripped through the modeler.
 */

export async function getModelFromModeler(modeler: Modeler): Promise<BpmnModel> {
  const { xml } = await modeler.saveXML({ format: true });
  return importBpmn(xml!);
}

export async function loadModelIntoModeler(modeler: Modeler, model: BpmnModel): Promise<void> {
  const xml = exportBpmn(model);
  await modeler.importXML(xml);
  fitViewport(modeler);
}

export async function getXml(modeler: Modeler): Promise<string> {
  const { xml } = await modeler.saveXML({ format: true });
  return xml!;
}

export function fitViewport(modeler: Modeler): void {
  try {
    (modeler.get("canvas") as any).zoom("fit-viewport", "auto");
  } catch {
    /* canvas not ready */
  }
}

/** Re-layout + re-route the current diagram with the custom engine. */
export async function cleanupDiagram(modeler: Modeler): Promise<void> {
  const model = await getModelFromModeler(modeler);
  for (const proc of Object.values(model.processes)) autoLayout(model, proc.id);
  await loadModelIntoModeler(modeler, model);
}

/** Re-route flows only (no shape moves) with the custom engine. */
export async function cleanupFlows(modeler: Modeler): Promise<void> {
  const model = await getModelFromModeler(modeler);
  for (const proc of Object.values(model.processes)) rerouteOnly(model, proc.id);
  await loadModelIntoModeler(modeler, model);
}

/** A clean starter diagram produced by the engine (with real DI geometry). */
export function initialXml(): string {
  const m = emptyModel({ processId: "Process_1", name: "Neuer Prozess" });
  const s = createNode(m, "startEvent", { name: "Start" });
  const t = createNode(m, "userTask", { name: "Anfrage bearbeiten" });
  const e = createNode(m, "endEvent", { name: "Fertig" });
  createEdge(m, "sequenceFlow", s.id, t.id);
  createEdge(m, "sequenceFlow", t.id, e.id);
  autoLayout(m, m.rootProcessId);
  return exportBpmn(m);
}
