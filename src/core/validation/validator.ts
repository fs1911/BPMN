import { BpmnModel, Edge, FlowNode, isActivity } from "../model";

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  rule: string;
  severity: Severity;
  /** plain-language description of what is wrong. */
  message: string;
  /** concrete, actionable fix in plain language. */
  hint?: string;
  elementId?: string;
  /** further elements involved (highlighted together with elementId) */
  relatedIds?: string[];
  /** example run leading to the problem (element names), from the simulation */
  trace?: string[];
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
      add({ rule: "flow.endpoints", severity: "error", message: `Ein Sequenzfluss hängt in der Luft (Start- oder Endpunkt fehlt).`, hint: "Verbinde den Pfeil mit zwei vorhandenen Elementen oder lösche ihn.", elementId: e.id });
      continue;
    }
    if (processOf[s.id] !== processOf[t.id]) {
      add({
        rule: "flow.same-pool",
        severity: "error",
        message: `Der Pfeil „${e.name ?? "(ohne Name)"}“ verbindet zwei verschiedene Pools mit einem Sequenzfluss.`,
        hint: "Innerhalb eines Pools: Sequenzfluss. Zwischen zwei Pools: Nachrichtenfluss (gestrichelt) verwenden.",
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
        message: `Der Nachrichtenfluss „${e.name ?? "(ohne Name)"}“ bleibt innerhalb eines Pools.`,
        hint: "Nachrichtenflüsse modellieren Kommunikation ZWISCHEN Pools. Innerhalb eines Pools stattdessen einen Sequenzfluss verwenden.",
        elementId: e.id,
      });
    }
  }
}

function validateLanes(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  for (const lane of Object.values(model.lanes)) {
    const proc = model.processes[lane.parent];
    if (!proc) {
      add({ rule: "lane.in-pool", severity: "error", message: `Die Bahn „${lane.name ?? lane.id}“ liegt in keinem Pool.`, hint: "Bahnen (Rollen) gehören immer in einen Pool. Lege einen Pool an und ordne die Bahn dort ein.", elementId: lane.id });
    }
  }
}

function validateEvents(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const adj = anyScopeAdjacency(model);
  for (const n of Object.values(model.nodes)) {
    const out = adj.outgoing[n.id] ?? [];
    const inc = adj.incoming[n.id] ?? [];
    if (n.type === "startEvent") {
      if (inc.length) add({ rule: "event.start-no-incoming", severity: "error", message: `Auf das Startereignis „${label(n)}“ zeigt ein Pfeil.`, hint: "Ein Start beginnt den Prozess – es darf nichts hineinfließen. Eingehenden Pfeil entfernen.", elementId: n.id });
      if (!out.length) add({ rule: "event.start-outgoing", severity: "warning", message: `Vom Start „${label(n)}“ geht kein Pfeil aus.`, hint: "Verbinde den Start mit dem ersten Schritt des Prozesses.", elementId: n.id });
    }
    if (n.type === "endEvent") {
      if (out.length) add({ rule: "event.end-no-outgoing", severity: "error", message: `Vom Endereignis „${label(n)}“ geht ein Pfeil aus.`, hint: "Ein Ende schließt den Prozess ab – von dort darf nichts mehr weitergehen. Ausgehenden Pfeil entfernen.", elementId: n.id });
      if (!inc.length) add({ rule: "event.end-incoming", severity: "warning", message: `Auf das Ende „${label(n)}“ zeigt kein Pfeil.`, hint: "Verbinde den letzten Schritt mit diesem Endereignis.", elementId: n.id });
    }
    if (n.type === "boundaryEvent") {
      if (!n.attachedToRef || !model.nodes[n.attachedToRef]) {
        add({ rule: "event.boundary-host", severity: "error", message: `Das Rand-Ereignis „${label(n)}“ klebt an keiner Aufgabe.`, hint: "Ziehe das Ereignis auf den Rand einer Aktivität (z. B. für einen Timer oder eine Fehlerbehandlung).", elementId: n.id });
      } else if (!isActivity(model.nodes[n.attachedToRef].type)) {
        add({ rule: "event.boundary-host", severity: "error", message: `Das Rand-Ereignis „${label(n)}“ hängt an einem Element, das keine Aufgabe ist.`, hint: "Rand-Ereignisse gehören an Aktivitäten (Aufgaben/Teilprozesse), nicht an Gateways oder Ereignisse.", elementId: n.id });
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
      add({
        rule: "gateway.degenerate",
        severity: "warning",
        message: `Das Gateway „${label(n)}“ teilt nichts auf und führt nichts zusammen.`,
        hint: "Ein Gateway mit nur einem Eingang und einem Ausgang ist überflüssig – entfernen und die beiden Flüsse direkt verbinden.",
        elementId: n.id,
      });
    }
    if ((n.type === "exclusiveGateway" || n.type === "inclusiveGateway") && out.length > 1) {
      // A path counts as "answered" if it has a label OR a condition OR is the
      // default — an unlabelled, unconditioned path is the real problem.
      const unlabelled = out.filter((e) => !e.condition && !e.isDefault && !(e.name && e.name.trim()));
      const defaults = out.filter((e) => e.isDefault);
      if (unlabelled.length) {
        add({
          rule: "gateway.conditions",
          severity: "warning",
          message: `Beim Gateway „${label(n)}“ ${unlabelled.length === 1 ? "ist ein Ausgang" : `sind ${unlabelled.length} Ausgänge`} nicht beschriftet.`,
          hint: "Beschrifte jeden Ausgang mit seiner Antwort (z. B. „ja“ / „nein“), damit klar ist, wann welcher Weg genommen wird.",
          elementId: n.id,
        });
      }
      if (defaults.length > 1) {
        add({
          rule: "gateway.default",
          severity: "error",
          message: `Das Gateway „${label(n)}“ hat mehrere Standard-Ausgänge.`,
          hint: "Es darf nur einen Standardfluss geben. Entferne die Standard-Markierung bei den übrigen Ausgängen.",
          elementId: n.id,
        });
      }
    }
    if (n.type === "parallelGateway") {
      for (const e of out) {
        if (e.condition)
          add({
            rule: "gateway.parallel-condition",
            severity: "error",
            message: `Ein paralleles Gateway („${label(n)}“) hat einen Ausgang mit Bedingung.`,
            hint: "Parallele Gateways führen IMMER alle Wege gleichzeitig aus – Bedingungen sind hier nicht erlaubt. Nutze ein exklusives Gateway, wenn du entscheiden willst.",
            elementId: e.id,
          });
      }
    }
    if (n.type === "eventBasedGateway") {
      for (const e of out) {
        const tgt = model.nodes[e.target];
        if (tgt && tgt.type !== "intermediateCatchEvent" && !tgt.type.endsWith("Task")) {
          add({
            rule: "gateway.event-based-targets",
            severity: "warning",
            message: `Auf das ereignisbasierte Gateway „${label(n)}“ folgt etwas anderes als ein Ereignis.`,
            hint: "Nach einem ereignisbasierten Gateway müssen fangende Ereignisse oder Empfangsaufgaben kommen (das Gateway wartet auf das erste eintreffende Ereignis).",
            elementId: n.id,
          });
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
      add({ rule: "connectivity.isolated", severity: "warning", message: `„${label(n)}“ ist mit nichts verbunden.`, hint: "Verbinde das Element mit dem Ablauf oder entferne es.", elementId: n.id });
    }
  }
}

function validateReadability(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  for (const n of Object.values(model.nodes)) {
    if (isActivity(n.type)) {
      if (!n.name || !n.name.trim()) {
        add({ rule: "readability.task-name", severity: "warning", message: `Eine Aufgabe hat keinen Namen.`, hint: "Benenne sie als Tätigkeit (Verb + Objekt), z. B. „Rechnung freigeben“.", elementId: n.id });
      } else if (!looksLikeObjectVerb(n.name)) {
        add({ rule: "readability.object-verb", severity: "info", message: `„${n.name}“ liest sich evtl. nicht wie eine Tätigkeit.`, hint: "Tipp: Verb + Objekt verwenden, z. B. „Antrag prüfen“ statt „Antrag“.", elementId: n.id });
      }
    }
    if (n.type === "exclusiveGateway" && n.name && !n.name.trim().endsWith("?")) {
      add({ rule: "readability.gateway-question", severity: "info", message: `Das Gateway „${n.name}“ ist nicht als Frage formuliert.`, hint: "Entscheidungen liest man am besten als Frage, z. B. „Betrag > 1000 €?“.", elementId: n.id });
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
