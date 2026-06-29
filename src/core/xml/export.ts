import {
  BpmnModel,
  Edge,
  EventDefinitionType,
  FlowNode,
  Lane,
} from "../model";

/**
 * Serialize a BpmnModel to standards-compliant BPMN 2.0 XML including BPMNDI.
 * Output is import-compatible with bpmn-js / Camunda Modeler. Diagram
 * interchange coordinates are absolute, matching the bpmn-io convention.
 */

const NS = {
  bpmn: "http://www.omg.org/spec/BPMN/20100524/MODEL",
  bpmndi: "http://www.omg.org/spec/BPMN/20100524/DI",
  dc: "http://www.omg.org/spec/DD/20100524/DC",
  di: "http://www.omg.org/spec/DD/20100524/DI",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
};

function esc(s: string | undefined): string {
  if (s == null) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EVENT_DEF_TAG: Record<Exclude<EventDefinitionType, "none">, string> = {
  message: "messageEventDefinition",
  timer: "timerEventDefinition",
  error: "errorEventDefinition",
  signal: "signalEventDefinition",
  escalation: "escalationEventDefinition",
  conditional: "conditionalEventDefinition",
  link: "linkEventDefinition",
  compensate: "compensateEventDefinition",
  terminate: "terminateEventDefinition",
};

class Writer {
  private parts: string[] = [];
  private indent = 0;
  line(s: string) {
    this.parts.push("  ".repeat(this.indent) + s);
  }
  open(s: string) {
    this.line(s);
    this.indent++;
  }
  close(s: string) {
    this.indent--;
    this.line(s);
  }
  toString() {
    return this.parts.join("\n");
  }
}

export function exportBpmn(model: BpmnModel): string {
  const w = new Writer();
  w.line('<?xml version="1.0" encoding="UTF-8"?>');
  w.open(
    `<bpmn:definitions xmlns:bpmn="${NS.bpmn}" xmlns:bpmndi="${NS.bpmndi}" xmlns:dc="${NS.dc}" xmlns:di="${NS.di}" xmlns:xsi="${NS.xsi}" id="${esc(model.id)}" targetNamespace="http://flowcraft/bpmn">`,
  );

  const participants = Object.values(model.participants);
  if (participants.length) {
    w.open(`<bpmn:collaboration id="Collaboration_1">`);
    for (const p of participants) {
      const ref = p.processRef ? ` processRef="${esc(p.processRef)}"` : "";
      w.line(`<bpmn:participant id="${esc(p.id)}" name="${esc(p.name)}"${ref} />`);
    }
    for (const e of Object.values(model.edges)) {
      if (e.type !== "messageFlow") continue;
      w.line(
        `<bpmn:messageFlow id="${esc(e.id)}" name="${esc(e.name)}" sourceRef="${esc(e.source)}" targetRef="${esc(e.target)}" />`,
      );
    }
    w.close(`</bpmn:collaboration>`);
  }

  for (const proc of Object.values(model.processes)) {
    writeProcess(w, model, proc.id);
  }

  writeDiagram(w, model);

  w.close(`</bpmn:definitions>`);
  return w.toString();
}

function writeProcess(w: Writer, model: BpmnModel, processId: string): void {
  const proc = model.processes[processId];
  w.open(`<bpmn:process id="${esc(proc.id)}" name="${esc(proc.name)}" isExecutable="${proc.isExecutable ? "true" : "false"}">`);

  // Lane set
  if (proc.lanes.length) {
    w.open(`<bpmn:laneSet id="LaneSet_${esc(proc.id)}">`);
    for (const lid of proc.lanes) {
      const lane = model.lanes[lid];
      writeLane(w, lane);
    }
    w.close(`</bpmn:laneSet>`);
  }

  writeScopeChildren(w, model, processId);
  w.close(`</bpmn:process>`);
}

function writeLane(w: Writer, lane: Lane): void {
  if (!lane.flowNodeRefs.length) {
    w.line(`<bpmn:lane id="${esc(lane.id)}" name="${esc(lane.name)}" />`);
    return;
  }
  w.open(`<bpmn:lane id="${esc(lane.id)}" name="${esc(lane.name)}">`);
  for (const ref of lane.flowNodeRefs) w.line(`<bpmn:flowNodeRef>${esc(ref)}</bpmn:flowNodeRef>`);
  w.close(`</bpmn:lane>`);
}

/** Emit all flow nodes and sequence flows whose scope is `scopeId`. */
function writeScopeChildren(w: Writer, model: BpmnModel, scopeId: string): void {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scopeId);
  for (const n of nodes) writeNode(w, model, n);
  for (const e of Object.values(model.edges)) {
    if (e.type !== "sequenceFlow") continue;
    const s = model.nodes[e.source];
    const t = model.nodes[e.target];
    if (s?.parent === scopeId && t?.parent === scopeId) writeSequenceFlow(w, e);
  }
}

function writeSequenceFlow(w: Writer, e: Edge): void {
  if (!e.condition) {
    w.line(`<bpmn:sequenceFlow id="${esc(e.id)}" name="${esc(e.name)}" sourceRef="${esc(e.source)}" targetRef="${esc(e.target)}" />`);
    return;
  }
  w.open(`<bpmn:sequenceFlow id="${esc(e.id)}" name="${esc(e.name)}" sourceRef="${esc(e.source)}" targetRef="${esc(e.target)}">`);
  w.line(`<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${esc(e.condition)}</bpmn:conditionExpression>`);
  w.close(`</bpmn:sequenceFlow>`);
}

function nodeAttrs(model: BpmnModel, n: FlowNode): string {
  let attrs = `id="${esc(n.id)}" name="${esc(n.name)}"`;
  if (n.type === "boundaryEvent") {
    attrs += ` attachedToRef="${esc(n.attachedToRef)}"`;
    if (n.cancelActivity === false) attrs += ` cancelActivity="false"`;
  }
  if (n.type === "callActivity" && n.calledElement) attrs += ` calledElement="${esc(n.calledElement)}"`;
  // default flow attribute
  const defaultEdge = Object.values(model.edges).find((e) => e.source === n.id && e.isDefault);
  if (defaultEdge) attrs += ` default="${esc(defaultEdge.id)}"`;
  return attrs;
}

function writeNode(w: Writer, model: BpmnModel, n: FlowNode): void {
  const tag = `bpmn:${n.type}`;
  const inner: string[] = [];
  // documentation
  if (n.documentation) inner.push(`<bpmn:documentation>${esc(n.documentation)}</bpmn:documentation>`);
  // event definitions
  if (n.eventDefinition && n.eventDefinition !== "none") {
    inner.push(`<bpmn:${EVENT_DEF_TAG[n.eventDefinition]} />`);
  }
  // markers
  if (n.markers?.loop) inner.push(`<bpmn:standardLoopCharacteristics />`);
  if (n.markers?.multiInstance) {
    inner.push(`<bpmn:multiInstanceLoopCharacteristics isSequential="${n.markers.multiInstance === "sequential"}" />`);
  }

  const hasChildren = n.type === "subProcess";
  if (!inner.length && !hasChildren) {
    w.line(`<${tag} ${nodeAttrs(model, n)} />`);
    return;
  }

  w.open(`<${tag} ${nodeAttrs(model, n)}>`);
  for (const i of inner) w.line(i);
  if (hasChildren) writeScopeChildren(w, model, n.id);
  w.close(`</${tag}>`);
}

function writeDiagram(w: Writer, model: BpmnModel): void {
  const planeElement = Object.values(model.participants).length
    ? "Collaboration_1"
    : model.rootProcessId;
  w.open(`<bpmndi:BPMNDiagram id="BPMNDiagram_1">`);
  w.open(`<bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${esc(planeElement)}">`);

  // participants
  for (const p of Object.values(model.participants)) {
    w.open(`<bpmndi:BPMNShape id="${esc(p.id)}_di" bpmnElement="${esc(p.id)}" isHorizontal="true">`);
    w.line(boundsXml(p.bounds));
    w.close(`</bpmndi:BPMNShape>`);
  }
  // lanes
  for (const lane of Object.values(model.lanes)) {
    w.open(`<bpmndi:BPMNShape id="${esc(lane.id)}_di" bpmnElement="${esc(lane.id)}" isHorizontal="true">`);
    w.line(boundsXml(lane.bounds));
    w.close(`</bpmndi:BPMNShape>`);
  }
  // nodes
  for (const n of Object.values(model.nodes)) {
    const expanded =
      n.type === "subProcess" ? ` isExpanded="${n.collapsed ? "false" : "true"}"` : "";
    w.open(`<bpmndi:BPMNShape id="${esc(n.id)}_di" bpmnElement="${esc(n.id)}"${expanded}>`);
    w.line(boundsXml(n.bounds));
    w.close(`</bpmndi:BPMNShape>`);
  }
  // edges
  for (const e of Object.values(model.edges)) {
    if (e.type === "association" && !e.waypoints) continue;
    w.open(`<bpmndi:BPMNEdge id="${esc(e.id)}_di" bpmnElement="${esc(e.id)}">`);
    const wps = e.waypoints ?? [];
    for (const p of wps) w.line(`<di:waypoint x="${round(p.x)}" y="${round(p.y)}" />`);
    w.close(`</bpmndi:BPMNEdge>`);
  }

  w.close(`</bpmndi:BPMNPlane>`);
  w.close(`</bpmndi:BPMNDiagram>`);
}

function boundsXml(b: { x: number; y: number; width: number; height: number }): string {
  return `<dc:Bounds x="${round(b.x)}" y="${round(b.y)}" width="${round(b.width)}" height="${round(b.height)}" />`;
}

function round(n: number): number {
  return Math.round(n);
}
