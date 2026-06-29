import { BpmnModel, Edge, FlowNode, isActivity } from "../model";

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  rule: string;
  severity: Severity;
  message: string;
  elementId?: string;
}

/**
 * Structural + semantic BPMN validation. Covers the rules called out in the
 * product spec: scope-correct sequence/message flows, lane containment, gateway
 * split/join semantics, event well-formedness and readability hints.
 */
export function validate(model: BpmnModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (i: ValidationIssue) => issues.push(i);

  const processOf = nodeProcessMap(model);

  validateFlowScopes(model, processOf, add);
  validateMessageFlows(model, processOf, add);
  validateLanes(model, add);
  validateEvents(model, add);
  validateGateways(model, add);
  validateConnectivity(model, add);
  validateReadability(model, add);

  return issues;
}

/** Map every node to the id of its owning top-level participant/process. */
function nodeProcessMap(model: BpmnModel): Record<string, string> {
  // Resolve a node's process scope by walking parent subprocess chain to root.
  const cache: Record<string, string> = {};
  const resolve = (id: string): string => {
    if (cache[id]) return cache[id];
    const n = model.nodes[id];
    if (!n) return model.rootProcessId;
    let parent = n.parent;
    // climb subprocess parents
    while (model.nodes[parent]) parent = model.nodes[parent].parent;
    cache[id] = parent;
    return parent;
  };
  for (const id of Object.keys(model.nodes)) resolve(id);
  return cache;
}

function validateFlowScopes(
  model: BpmnModel,
  processOf: Record<string, string>,
  add: (i: ValidationIssue) => void,
): void {
  for (const e of Object.values(model.edges)) {
    if (e.type !== "sequenceFlow") continue;
    const s = model.nodes[e.source];
    const t = model.nodes[e.target];
    if (!s || !t) {
      add({ rule: "flow.endpoints", severity: "error", message: `Sequenzfluss ${e.id} hat einen fehlenden Endpunkt.`, elementId: e.id });
      continue;
    }
    if (processOf[s.id] !== processOf[t.id]) {
      add({
        rule: "flow.same-pool",
        severity: "error",
        message: `Sequenzfluss „${e.name ?? e.id}“ verbindet Elemente in verschiedenen Pools. Verwenden Sie zwischen Pools einen Nachrichtenfluss.`,
        elementId: e.id,
      });
    }
  }
}

function validateMessageFlows(
  model: BpmnModel,
  processOf: Record<string, string>,
  add: (i: ValidationIssue) => void,
): void {
  for (const e of Object.values(model.edges)) {
    if (e.type !== "messageFlow") continue;
    const sProc = model.nodes[e.source] ? processOf[e.source] : e.source;
    const tProc = model.nodes[e.target] ? processOf[e.target] : e.target;
    if (sProc === tProc) {
      add({
        rule: "messageflow.cross-pool",
        severity: "error",
        message: `Nachrichtenfluss „${e.name ?? e.id}“ muss zwei verschiedene Pools verbinden.`,
        elementId: e.id,
      });
    }
  }
}

function validateLanes(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  for (const lane of Object.values(model.lanes)) {
    const proc = model.processes[lane.parent];
    if (!proc) {
      add({ rule: "lane.in-pool", severity: "error", message: `Bahn „${lane.name ?? lane.id}“ ist in keinem Prozess/Pool enthalten.`, elementId: lane.id });
    }
  }
}

function validateEvents(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const adj = anyScopeAdjacency(model);
  for (const n of Object.values(model.nodes)) {
    const out = adj.outgoing[n.id] ?? [];
    const inc = adj.incoming[n.id] ?? [];
    if (n.type === "startEvent") {
      if (inc.length) add({ rule: "event.start-no-incoming", severity: "error", message: `Startereignis „${label(n)}“ darf keine eingehenden Sequenzflüsse haben.`, elementId: n.id });
      if (!out.length) add({ rule: "event.start-outgoing", severity: "warning", message: `Startereignis „${label(n)}“ hat keinen ausgehenden Fluss.`, elementId: n.id });
    }
    if (n.type === "endEvent") {
      if (out.length) add({ rule: "event.end-no-outgoing", severity: "error", message: `Endereignis „${label(n)}“ darf keine ausgehenden Sequenzflüsse haben.`, elementId: n.id });
      if (!inc.length) add({ rule: "event.end-incoming", severity: "warning", message: `Endereignis „${label(n)}“ hat keinen eingehenden Fluss.`, elementId: n.id });
    }
    if (n.type === "boundaryEvent") {
      if (!n.attachedToRef || !model.nodes[n.attachedToRef]) {
        add({ rule: "event.boundary-host", severity: "error", message: `Rand-Ereignis „${label(n)}“ muss an eine Aktivität angeheftet sein.`, elementId: n.id });
      } else if (!isActivity(model.nodes[n.attachedToRef].type)) {
        add({ rule: "event.boundary-host", severity: "error", message: `Rand-Ereignis „${label(n)}“ muss an eine Aktivität angeheftet sein, nicht an ${model.nodes[n.attachedToRef].type}.`, elementId: n.id });
      }
    }
  }
}

function validateGateways(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const adj = anyScopeAdjacency(model);
  for (const n of Object.values(model.nodes)) {
    if (!n.type.endsWith("Gateway")) continue;
    const out = adj.outgoing[n.id] ?? [];
    const inc = adj.incoming[n.id] ?? [];
    if (out.length <= 1 && inc.length <= 1) {
      add({ rule: "gateway.degenerate", severity: "warning", message: `Gateway „${label(n)}“ verzweigt und führt nichts zusammen (1 ein/1 aus). Entfernen erwägen.`, elementId: n.id });
    }
    if ((n.type === "exclusiveGateway" || n.type === "inclusiveGateway") && out.length > 1) {
      const withoutCondition = out.filter((e) => !e.condition && !e.isDefault);
      const defaults = out.filter((e) => e.isDefault);
      if (withoutCondition.length) {
        add({ rule: "gateway.conditions", severity: "warning", message: `Ausgehende Flüsse des ${n.type} „${label(n)}“ sollten Bedingungen (Antworten) tragen. ${withoutCondition.length} Fluss/Flüsse ohne Bedingung.`, elementId: n.id });
      }
      if (defaults.length > 1) {
        add({ rule: "gateway.default", severity: "error", message: `Gateway „${label(n)}“ hat mehr als einen Standardfluss.`, elementId: n.id });
      }
    }
    if (n.type === "parallelGateway") {
      for (const e of out) {
        if (e.condition) add({ rule: "gateway.parallel-condition", severity: "error", message: `Paralleles Gateway „${label(n)}“ darf keine bedingten ausgehenden Flüsse haben.`, elementId: e.id });
      }
    }
    if (n.type === "eventBasedGateway") {
      for (const e of out) {
        const tgt = model.nodes[e.target];
        if (tgt && tgt.type !== "intermediateCatchEvent" && !tgt.type.endsWith("Task")) {
          add({ rule: "gateway.event-based-targets", severity: "warning", message: `Auf ein ereignisbasiertes Gateway „${label(n)}“ sollten fangende Ereignisse oder Empfangsaufgaben folgen.`, elementId: n.id });
        }
      }
    }
  }
}

function validateConnectivity(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const adj = anyScopeAdjacency(model);
  for (const n of Object.values(model.nodes)) {
    if (n.type === "boundaryEvent" || n.type === "textAnnotation" || n.type.startsWith("data")) continue;
    const out = adj.outgoing[n.id] ?? [];
    const inc = adj.incoming[n.id] ?? [];
    if (out.length === 0 && inc.length === 0) {
      add({ rule: "connectivity.isolated", severity: "warning", message: `Element „${label(n)}“ ist nicht mit dem Ablauf verbunden.`, elementId: n.id });
    }
  }
}

function validateReadability(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  for (const n of Object.values(model.nodes)) {
    if (isActivity(n.type)) {
      if (!n.name || !n.name.trim()) {
        add({ rule: "readability.task-name", severity: "warning", message: `Aktivität ${n.id} hat keinen Namen. Verwenden Sie Objekt + Verb (z. B. „Rechnung freigeben“).`, elementId: n.id });
      } else if (!looksLikeObjectVerb(n.name)) {
        add({ rule: "readability.object-verb", severity: "info", message: `Aufgabe „${n.name}“ folgt evtl. nicht der Objekt-+-Verb-Benennung.`, elementId: n.id });
      }
    }
    if (n.type === "exclusiveGateway" && n.name && !n.name.trim().endsWith("?")) {
      add({ rule: "readability.gateway-question", severity: "info", message: `Exklusives Gateway „${n.name}“ sollte üblicherweise als Frage formuliert werden.`, elementId: n.id });
    }
  }
}

function looksLikeObjectVerb(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return false;
  // Heuristic: starts with a verb-like token (no trailing 'ing' noun phrase rule), contains >=2 words.
  return /^[A-Za-z]/.test(words[0]);
}

function label(n: FlowNode): string {
  return n.name?.trim() || n.id;
}

/** Adjacency over all scopes combined (used for endpoint-degree checks). */
function anyScopeAdjacency(model: BpmnModel) {
  const outgoing: Record<string, Edge[]> = {};
  const incoming: Record<string, Edge[]> = {};
  for (const id of Object.keys(model.nodes)) {
    outgoing[id] = [];
    incoming[id] = [];
  }
  for (const e of Object.values(model.edges)) {
    if (e.type !== "sequenceFlow") continue;
    if (model.nodes[e.source]) outgoing[e.source].push(e);
    if (model.nodes[e.target]) incoming[e.target].push(e);
  }
  return { outgoing, incoming };
}

/** Convenience summary for UI badges. */
export function summarize(issues: ValidationIssue[]): { errors: number; warnings: number; infos: number } {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    infos: issues.filter((i) => i.severity === "info").length,
  };
}
