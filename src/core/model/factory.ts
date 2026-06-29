import {
  BpmnModel,
  Edge,
  EdgeType,
  FlowElementType,
  FlowNode,
  Lane,
  Participant,
  ProcessScope,
  defaultSizeFor,
} from "./types";

let _counter = 0;
/** Deterministic-ish id generator. Prefix keeps BPMN XML readable. */
export function genId(prefix: string): string {
  _counter += 1;
  return `${prefix}_${_counter.toString(36)}${Date.now().toString(36).slice(-3)}`;
}

/** Reset the id counter — used by tests for deterministic output. */
export function resetIdCounter(): void {
  _counter = 0;
}

export function emptyModel(opts?: { processId?: string; name?: string }): BpmnModel {
  const rootProcessId = opts?.processId ?? "Process_1";
  const process: ProcessScope = {
    id: rootProcessId,
    name: opts?.name,
    isExecutable: true,
    lanes: [],
  };
  return {
    id: "Definitions_1",
    name: opts?.name,
    nodes: {},
    edges: {},
    lanes: {},
    participants: {},
    processes: { [rootProcessId]: process },
    rootProcessId,
  };
}

export function createNode(
  model: BpmnModel,
  type: FlowElementType,
  partial: Partial<FlowNode> = {},
): FlowNode {
  const size = defaultSizeFor(type);
  const node: FlowNode = {
    id: partial.id ?? genId(type),
    type,
    name: partial.name,
    parent: partial.parent ?? model.rootProcessId,
    lane: partial.lane,
    bounds: partial.bounds ?? { x: 0, y: 0, width: size.width, height: size.height },
    eventDefinition: partial.eventDefinition,
    cancelActivity: partial.cancelActivity,
    attachedToRef: partial.attachedToRef,
    collapsed: partial.collapsed,
    calledElement: partial.calledElement,
    markers: partial.markers,
    documentation: partial.documentation,
    provenance: partial.provenance,
  };
  model.nodes[node.id] = node;
  if (node.lane && model.lanes[node.lane]) {
    const refs = model.lanes[node.lane].flowNodeRefs;
    if (!refs.includes(node.id)) refs.push(node.id);
  }
  return node;
}

export function createEdge(
  model: BpmnModel,
  type: EdgeType,
  source: string,
  target: string,
  partial: Partial<Edge> = {},
): Edge {
  const edge: Edge = {
    id: partial.id ?? genId(type),
    type,
    source,
    target,
    name: partial.name,
    condition: partial.condition,
    isDefault: partial.isDefault,
    waypoints: partial.waypoints,
    documentation: partial.documentation,
    provenance: partial.provenance,
  };
  model.edges[edge.id] = edge;
  return edge;
}

export function createLane(model: BpmnModel, partial: Partial<Lane> = {}): Lane {
  const lane: Lane = {
    id: partial.id ?? genId("Lane"),
    name: partial.name,
    parent: partial.parent ?? model.rootProcessId,
    bounds: partial.bounds ?? { x: 0, y: 0, width: 600, height: 150 },
    flowNodeRefs: partial.flowNodeRefs ?? [],
  };
  model.lanes[lane.id] = lane;
  const proc = model.processes[lane.parent];
  if (proc && !proc.lanes.includes(lane.id)) proc.lanes.push(lane.id);
  return lane;
}

export function createParticipant(
  model: BpmnModel,
  partial: Partial<Participant> = {},
): Participant {
  const p: Participant = {
    id: partial.id ?? genId("Participant"),
    name: partial.name,
    processRef: partial.processRef,
    bounds: partial.bounds ?? { x: 0, y: 0, width: 600, height: 250 },
  };
  model.participants[p.id] = p;
  return p;
}

export function createProcess(model: BpmnModel, partial: Partial<ProcessScope> = {}): ProcessScope {
  const proc: ProcessScope = {
    id: partial.id ?? genId("Process"),
    name: partial.name,
    isExecutable: partial.isExecutable ?? false,
    lanes: partial.lanes ?? [],
  };
  model.processes[proc.id] = proc;
  return proc;
}

/** Deep clone a model (for command/undo snapshots and AI staging). */
export function cloneModel(model: BpmnModel): BpmnModel {
  return JSON.parse(JSON.stringify(model)) as BpmnModel;
}
