import { XMLParser } from "fast-xml-parser";
import {
  Bounds,
  BpmnModel,
  EdgeType,
  EventDefinitionType,
  FlowElementType,
  Waypoint,
  emptyModel,
} from "../model";

/**
 * Parse BPMN 2.0 XML into a BpmnModel. Handles collaborations (pools/lanes),
 * nested subprocesses, event definitions, markers, conditions, default flows
 * and full BPMNDI geometry. Namespace prefixes are stripped so the importer is
 * tolerant of bpmn-js, Camunda Modeler and Signavio exports alike.
 */

const NODE_TYPES: FlowElementType[] = [
  "startEvent",
  "endEvent",
  "intermediateThrowEvent",
  "intermediateCatchEvent",
  "boundaryEvent",
  "task",
  "userTask",
  "serviceTask",
  "scriptTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "businessRuleTask",
  "subProcess",
  "callActivity",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
  "dataObjectReference",
  "dataStoreReference",
  "textAnnotation",
];

const EVENT_DEF_MAP: Record<string, EventDefinitionType> = {
  messageEventDefinition: "message",
  timerEventDefinition: "timer",
  errorEventDefinition: "error",
  signalEventDefinition: "signal",
  escalationEventDefinition: "escalation",
  conditionalEventDefinition: "conditional",
  linkEventDefinition: "link",
  compensateEventDefinition: "compensate",
  terminateEventDefinition: "terminate",
};

const ARRAY_TAGS = new Set([
  "participant",
  "messageFlow",
  "process",
  "lane",
  "flowNodeRef",
  "sequenceFlow",
  "BPMNShape",
  "BPMNEdge",
  "waypoint",
  "BPMNDiagram",
  ...NODE_TYPES,
]);

function arr<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function importBpmn(xml: string): BpmnModel {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (name) => ARRAY_TAGS.has(name),
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml);
  const defs = doc.definitions ?? doc.Definitions;
  if (!defs) throw new Error("No <definitions> root element found.");

  const model = emptyModel({ processId: "Process_imported" });
  model.id = defs["@_id"] ?? "Definitions_1";
  model.processes = {};
  model.nodes = {};
  model.edges = {};

  // Processes
  const processes = arr<any>(defs.process);
  let firstProcId: string | undefined;
  for (const p of processes) {
    const pid = p["@_id"];
    if (!firstProcId) firstProcId = pid;
    model.processes[pid] = {
      id: pid,
      name: p["@_name"],
      isExecutable: p["@_isExecutable"] === "true",
      lanes: [],
    };
    importLaneSet(model, p, pid);
    importScope(model, p, pid);
  }
  model.rootProcessId = firstProcId ?? "Process_1";
  if (!model.processes[model.rootProcessId]) {
    model.processes[model.rootProcessId] = { id: model.rootProcessId, lanes: [], isExecutable: true };
  }

  // Collaboration (pools + message flows)
  const collab = defs.collaboration;
  if (collab) {
    for (const part of arr<any>(collab.participant)) {
      model.participants[part["@_id"]] = {
        id: part["@_id"],
        name: part["@_name"],
        processRef: part["@_processRef"],
        bounds: { x: 0, y: 0, width: 600, height: 250 },
      };
    }
    for (const mf of arr<any>(collab.messageFlow)) {
      addEdge(model, "messageFlow", mf);
    }
  }

  applyDefaultFlows(model, processes);
  importDiagram(model, defs);
  return model;
}

function importLaneSet(model: BpmnModel, scopeObj: any, scopeId: string): void {
  const laneSet = scopeObj.laneSet;
  if (!laneSet) return;
  for (const lane of arr<any>(laneSet.lane)) {
    const refs = arr<any>(lane.flowNodeRef).map((r) => (typeof r === "string" ? r : r["#text"]));
    model.lanes[lane["@_id"]] = {
      id: lane["@_id"],
      name: lane["@_name"],
      parent: scopeId,
      bounds: { x: 0, y: 0, width: 600, height: 150 },
      flowNodeRefs: refs,
    };
    model.processes[scopeId]?.lanes.push(lane["@_id"]);
  }
  // back-fill node.lane after nodes parsed (done in importScope via map below)
}

function laneForNode(model: BpmnModel, nodeId: string): string | undefined {
  for (const lane of Object.values(model.lanes)) {
    if (lane.flowNodeRefs.includes(nodeId)) return lane.id;
  }
  return undefined;
}

function importScope(model: BpmnModel, scopeObj: any, scopeId: string): void {
  for (const type of NODE_TYPES) {
    for (const raw of arr<any>(scopeObj[type])) {
      importNode(model, type, raw, scopeId);
    }
  }
  for (const sf of arr<any>(scopeObj.sequenceFlow)) {
    addEdge(model, "sequenceFlow", sf);
  }
  for (const as of arr<any>(scopeObj.association)) {
    addEdge(model, "association", as);
  }
}

function importNode(model: BpmnModel, type: FlowElementType, raw: any, scopeId: string): void {
  const id = raw["@_id"];
  let eventDefinition: EventDefinitionType | undefined;
  for (const [tag, def] of Object.entries(EVENT_DEF_MAP)) {
    if (raw[tag] !== undefined) eventDefinition = def;
  }
  const markers = {
    loop: raw.standardLoopCharacteristics !== undefined ? true : undefined,
    multiInstance:
      raw.multiInstanceLoopCharacteristics !== undefined
        ? raw.multiInstanceLoopCharacteristics["@_isSequential"] === "true"
          ? ("sequential" as const)
          : ("parallel" as const)
        : undefined,
  };
  model.nodes[id] = {
    id,
    type,
    name: raw["@_name"],
    parent: scopeId,
    lane: laneForNode(model, id),
    bounds: { x: 0, y: 0, width: 100, height: 80 },
    eventDefinition,
    cancelActivity: raw["@_cancelActivity"] !== undefined ? raw["@_cancelActivity"] === "true" : undefined,
    attachedToRef: raw["@_attachedToRef"],
    calledElement: raw["@_calledElement"],
    collapsed: type === "subProcess" ? false : undefined,
    markers: markers.loop || markers.multiInstance ? markers : undefined,
    documentation: typeof raw.documentation === "string" ? raw.documentation : raw.documentation?.["#text"],
  };
  // Nested subprocess content
  if (type === "subProcess") {
    importScope(model, raw, id);
  }
}

function addEdge(model: BpmnModel, type: EdgeType, raw: any): void {
  const condition =
    raw.conditionExpression !== undefined
      ? typeof raw.conditionExpression === "string"
        ? raw.conditionExpression
        : raw.conditionExpression["#text"]
      : undefined;
  model.edges[raw["@_id"]] = {
    id: raw["@_id"],
    type,
    source: raw["@_sourceRef"],
    target: raw["@_targetRef"],
    name: raw["@_name"],
    condition,
  };
}

function applyDefaultFlows(model: BpmnModel, processes: any[]): void {
  const markDefault = (scopeObj: any) => {
    for (const type of NODE_TYPES) {
      for (const raw of arr<any>(scopeObj[type])) {
        const def = raw["@_default"];
        if (def && model.edges[def]) model.edges[def].isDefault = true;
        if (type === "subProcess") markDefault(raw);
      }
    }
  };
  for (const p of processes) markDefault(p);
}

function importDiagram(model: BpmnModel, defs: any): void {
  const diagrams = arr<any>(defs.BPMNDiagram);
  for (const dia of diagrams) {
    const plane = dia.BPMNPlane;
    if (!plane) continue;
    for (const shape of arr<any>(plane.BPMNShape)) {
      const ref = shape["@_bpmnElement"];
      const b = parseBounds(shape.Bounds);
      if (!b) continue;
      if (model.nodes[ref]) model.nodes[ref].bounds = b;
      else if (model.lanes[ref]) model.lanes[ref].bounds = b;
      else if (model.participants[ref]) model.participants[ref].bounds = b;
      if (model.nodes[ref] && model.nodes[ref].type === "subProcess") {
        model.nodes[ref].collapsed = shape["@_isExpanded"] === "false";
      }
    }
    for (const edge of arr<any>(plane.BPMNEdge)) {
      const ref = edge["@_bpmnElement"];
      const wps: Waypoint[] = arr<any>(edge.waypoint).map((p) => ({
        x: Number(p["@_x"]),
        y: Number(p["@_y"]),
      }));
      if (model.edges[ref]) model.edges[ref].waypoints = wps.length ? wps : undefined;
    }
  }
}

function parseBounds(b: any): Bounds | undefined {
  if (!b) return undefined;
  return {
    x: Number(b["@_x"]),
    y: Number(b["@_y"]),
    width: Number(b["@_width"]),
    height: Number(b["@_height"]),
  };
}
