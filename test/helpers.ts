import {
  BpmnModel,
  Edge,
  FlowNode,
  buildAdjacency,
  createEdge,
  createNode,
  emptyModel,
  resetIdCounter,
} from "../src/core/model";

/** Build a small linear process with one XOR split/join and a rework loop. */
export function buildSampleProcess(): BpmnModel {
  resetIdCounter();
  const m = emptyModel({ processId: "P", name: "Sample" });
  const start = createNode(m, "startEvent", { id: "start", name: "Request received" });
  const receive = createNode(m, "userTask", { id: "receive", name: "Record request" });
  const check = createNode(m, "userTask", { id: "check", name: "Check documents" });
  const gw = createNode(m, "exclusiveGateway", { id: "gw", name: "Complete?" });
  const approve = createNode(m, "userTask", { id: "approve", name: "Approve request" });
  const end = createNode(m, "endEvent", { id: "end", name: "Request closed" });

  createEdge(m, "sequenceFlow", start.id, receive.id);
  createEdge(m, "sequenceFlow", receive.id, check.id);
  createEdge(m, "sequenceFlow", check.id, gw.id);
  createEdge(m, "sequenceFlow", gw.id, approve.id, { name: "complete", condition: "${complete}" });
  createEdge(m, "sequenceFlow", approve.id, end.id);
  // rework loop: incomplete -> back to record request (a back edge)
  createEdge(m, "sequenceFlow", gw.id, receive.id, { name: "incomplete", condition: "${incomplete}" });
  return m;
}

export function edgesBetween(m: BpmnModel, source: string, target: string): Edge[] {
  return Object.values(m.edges).filter((e) => e.source === source && e.target === target);
}

export function adjacency(m: BpmnModel, scope: string) {
  return buildAdjacency(m, { scope });
}

export function nodeById(m: BpmnModel, id: string): FlowNode {
  const n = m.nodes[id];
  if (!n) throw new Error(`node ${id} not found`);
  return n;
}
