/**
 * FlowCraft internal BPMN model.
 *
 * This is a normalized, framework-agnostic representation of a BPMN 2.0
 * process. It is intentionally NOT bpmn-js' moddle model: keeping our own
 * representation lets the layout engine, router, validator and AI pipeline
 * operate on a small, stable, strongly-typed surface and lets us round-trip
 * BPMN 2.0 XML without leaking library internals into the rest of the app.
 */

export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export type Waypoint = Point;

/** Marker decorations rendered on activities. */
export interface ActivityMarkers {
  loop?: boolean;
  /** standard / parallel multi-instance */
  multiInstance?: "parallel" | "sequential" | false;
  /** compensation handler marker */
  compensation?: boolean;
}

export type FlowElementType =
  // events
  | "startEvent"
  | "endEvent"
  | "intermediateThrowEvent"
  | "intermediateCatchEvent"
  | "boundaryEvent"
  // tasks / activities
  | "task"
  | "userTask"
  | "serviceTask"
  | "scriptTask"
  | "sendTask"
  | "receiveTask"
  | "manualTask"
  | "businessRuleTask"
  | "subProcess"
  | "callActivity"
  // gateways
  | "exclusiveGateway"
  | "parallelGateway"
  | "inclusiveGateway"
  | "eventBasedGateway"
  | "complexGateway"
  // data
  | "dataObjectReference"
  | "dataStoreReference"
  | "textAnnotation";

/** Event definition kinds attached to events. */
export type EventDefinitionType =
  | "none"
  | "message"
  | "timer"
  | "error"
  | "signal"
  | "escalation"
  | "conditional"
  | "link"
  | "compensate"
  | "terminate";

export interface FlowNode {
  id: string;
  type: FlowElementType;
  name?: string;
  /** id of the containing process/subprocess/lane-set scope (the process or subProcess id). */
  parent: string;
  /** lane id this node belongs to, if any. */
  lane?: string;
  bounds: Bounds;
  /** event definition (events only). */
  eventDefinition?: EventDefinitionType;
  /** whether a boundary event interrupts its host (default true). */
  cancelActivity?: boolean;
  /** host activity id for boundary events. */
  attachedToRef?: string;
  /** subprocess collapse state. */
  collapsed?: boolean;
  /** callActivity target reference (calledElement). */
  calledElement?: string;
  markers?: ActivityMarkers;
  /** free-form documentation. */
  documentation?: string;
  /** AI provenance: which sentence/snippet produced this element. */
  provenance?: string;
}

export type EdgeType = "sequenceFlow" | "messageFlow" | "association";

export interface Edge {
  id: string;
  type: EdgeType;
  source: string;
  target: string;
  name?: string;
  /** condition expression on a sequence flow leaving a gateway/activity. */
  condition?: string;
  /** marks the default flow out of a gateway/activity. */
  isDefault?: boolean;
  /** explicit routed waypoints (filled by the router; source of truth for DI). */
  waypoints?: Waypoint[];
  /** computed: true when this edge flows "backwards" against the dominant
   * reading order (a rework / loop back edge). Drives special routing. */
  isBackEdge?: boolean;
  documentation?: string;
  provenance?: string;
}

export interface Lane {
  id: string;
  name?: string;
  parent: string; // process or subprocess id
  bounds: Bounds;
  /** ordered child node ids assigned to this lane. */
  flowNodeRefs: string[];
}

export interface Participant {
  id: string;
  name?: string;
  /** referenced process id; undefined => black-box pool. */
  processRef?: string;
  bounds: Bounds;
}

/** A BPMN process (the top scope, or a subprocess scope). */
export interface ProcessScope {
  id: string;
  name?: string;
  isExecutable?: boolean;
  lanes: string[]; // lane ids
}

export interface BpmnModel {
  id: string;
  name?: string;
  nodes: Record<string, FlowNode>;
  edges: Record<string, Edge>;
  lanes: Record<string, Lane>;
  participants: Record<string, Participant>;
  processes: Record<string, ProcessScope>;
  /** id of the root/default process scope. */
  rootProcessId: string;
}

export const DEFAULT_SIZES: Record<string, { width: number; height: number }> = {
  event: { width: 36, height: 36 },
  task: { width: 120, height: 80 },
  gateway: { width: 50, height: 50 },
  subProcess: { width: 350, height: 200 },
  dataObjectReference: { width: 36, height: 50 },
  dataStoreReference: { width: 50, height: 50 },
  textAnnotation: { width: 100, height: 30 },
  participant: { width: 600, height: 250 },
};

export function isEvent(type: FlowElementType): boolean {
  return (
    type === "startEvent" ||
    type === "endEvent" ||
    type === "intermediateThrowEvent" ||
    type === "intermediateCatchEvent" ||
    type === "boundaryEvent"
  );
}

export function isGateway(type: FlowElementType): boolean {
  return type.endsWith("Gateway");
}

export function isActivity(type: FlowElementType): boolean {
  return (
    type === "task" ||
    type.endsWith("Task") ||
    type === "subProcess" ||
    type === "callActivity"
  );
}

export function isTaskLike(type: FlowElementType): boolean {
  return type === "task" || type.endsWith("Task");
}

export function defaultSizeFor(type: FlowElementType): { width: number; height: number } {
  if (isEvent(type)) return { ...DEFAULT_SIZES.event };
  if (isGateway(type)) return { ...DEFAULT_SIZES.gateway };
  if (type === "subProcess") return { ...DEFAULT_SIZES.subProcess };
  if (type === "dataObjectReference") return { ...DEFAULT_SIZES.dataObjectReference };
  if (type === "dataStoreReference") return { ...DEFAULT_SIZES.dataStoreReference };
  if (type === "textAnnotation") return { ...DEFAULT_SIZES.textAnnotation };
  return { ...DEFAULT_SIZES.task };
}
