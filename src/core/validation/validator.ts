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
  /** the rule comes from the standard: clause of ISO/IEC 19510 (BPMN 2.0.1), e.g. "10.5.4" */
  norm?: string;
  /** a style recommendation (readability, good practice), not a rule of the standard */
  style?: boolean;
}

/** Clauses of ISO/IEC 19510:2013 the rules refer to. */
const N = {
  sequenceFlow: "8.4.13",
  start: "10.5.2",
  end: "10.5.3",
  intermediate: "10.5.4",
  boundary: "10.5.4",
  gateway: "10.6.1",
  eventGateway: "10.6.6",
  soundness: "14.1",
} as const;

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
  validateLinks(model, add);
  validateStartEnd(model, add);
  validateConnectivity(model, add);
  validateReadability(model, add);
  validateStyle(model, add);

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
        norm: "7.6.1",
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
        norm: "7.6.2",
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
      if (inc.length) add({ rule: "event.start-no-incoming", norm: N.start, severity: "error", message: `Auf das Startereignis „${label(n)}“ zeigt ein Pfeil.`, hint: "Ein Start beginnt den Prozess – es darf nichts hineinfließen. Eingehenden Pfeil entfernen.", elementId: n.id });
      if (!out.length) add({ rule: "event.start-outgoing", norm: N.start, severity: "warning", message: `Vom Start „${label(n)}“ geht kein Pfeil aus.`, hint: "Verbinde den Start mit dem ersten Schritt des Prozesses.", elementId: n.id });
    }
    if (n.type === "endEvent") {
      if (out.length) add({ rule: "event.end-no-outgoing", norm: N.end, severity: "error", message: `Vom Endereignis „${label(n)}“ geht ein Pfeil aus.`, hint: "Ein Ende schließt den Prozess ab – von dort darf nichts mehr weitergehen. Ausgehenden Pfeil entfernen.", elementId: n.id });
      if (!inc.length) add({ rule: "event.end-incoming", norm: N.end, severity: "warning", message: `Auf das Ende „${label(n)}“ zeigt kein Pfeil.`, hint: "Verbinde den letzten Schritt mit diesem Endereignis.", elementId: n.id });
    }
    if (n.type === "boundaryEvent") {
      if (!n.attachedToRef || !model.nodes[n.attachedToRef]) {
        add({ rule: "event.boundary-host", norm: N.boundary, severity: "error", message: `Das Rand-Ereignis „${label(n)}“ klebt an keiner Aufgabe.`, hint: "Ziehe das Ereignis auf den Rand einer Aktivität (z. B. für einen Timer oder eine Fehlerbehandlung).", elementId: n.id });
      } else if (!isActivity(model.nodes[n.attachedToRef].type)) {
        add({ rule: "event.boundary-host", norm: N.boundary, severity: "error", message: `Das Rand-Ereignis „${label(n)}“ hängt an einem Element, das keine Aufgabe ist.`, hint: "Rand-Ereignisse gehören an Aktivitäten (Aufgaben/Teilprozesse), nicht an Gateways oder Ereignisse.", elementId: n.id });
      }
      validateBoundary(n, inc, out, add);
    }
    if (n.type === "intermediateCatchEvent" || n.type === "intermediateThrowEvent") validateIntermediate(n, inc, out, add);
  }
}

const BOUNDARY_TRIGGERS = new Set(["message", "timer", "error", "escalation", "conditional", "signal", "compensate"]);
const NON_INTERRUPTING = new Set(["message", "timer", "escalation", "conditional", "signal"]);
const TRIGGER_NAME: Record<string, string> = {
  none: "ohne Auslöser",
  message: "Nachricht",
  timer: "Zeit",
  error: "Fehler",
  signal: "Signal",
  escalation: "Eskalation",
  conditional: "Bedingung",
  link: "Link",
  compensate: "Kompensation",
  terminate: "Terminierung",
};
const trigger = (n: FlowNode) => n.eventDefinition ?? "none";

function validateBoundary(n: FlowNode, inc: Edge[], out: Edge[], add: (i: ValidationIssue) => void): void {
  const t = trigger(n);
  if (!BOUNDARY_TRIGGERS.has(t)) {
    add({
      rule: "event.boundary-trigger",
      norm: N.boundary,
      severity: "error",
      message: `Das Rand-Ereignis „${label(n)}“ hat keinen erlaubten Auslöser (${TRIGGER_NAME[t] ?? t}).`,
      hint: "Am Rand einer Aktivität sind nur Nachricht, Zeit, Fehler, Eskalation, Bedingung, Signal oder Kompensation möglich – den Auslöser im Element festlegen.",
      elementId: n.id,
    });
  } else if (n.cancelActivity === false && !NON_INTERRUPTING.has(t)) {
    add({
      rule: "event.boundary-noninterrupting",
      norm: N.boundary,
      severity: "error",
      message: `Das Rand-Ereignis „${label(n)}“ (${TRIGGER_NAME[t]}) ist als nicht unterbrechend markiert.`,
      hint: "Fehler und Kompensation brechen die Aktivität immer ab. Nur Nachricht, Zeit, Eskalation, Bedingung und Signal können sie weiterlaufen lassen.",
      elementId: n.id,
    });
  }
  if (inc.length) {
    add({ rule: "event.boundary-incoming", norm: N.boundary, severity: "error", message: `Auf das Rand-Ereignis „${label(n)}“ zeigt ein Pfeil.`, hint: "Ein Rand-Ereignis wird durch seine Aktivität ausgelöst, nicht durch einen Pfeil – eingehenden Pfeil entfernen.", elementId: n.id });
  }
  if (t === "compensate" ? out.length > 0 : !out.length) {
    add({
      rule: "event.boundary-outgoing",
      norm: N.boundary,
      severity: "error",
      message: t === "compensate" ? `Vom Kompensations-Rand-Ereignis „${label(n)}“ geht ein Sequenzfluss aus.` : `Vom Rand-Ereignis „${label(n)}“ geht kein Pfeil aus.`,
      hint: t === "compensate" ? "Die Kompensationsaktivität wird per Assoziation (gepunktet) angehängt, nicht per Sequenzfluss." : "Führe den Ausnahmeweg weiter – sonst ist unklar, was nach dem Ereignis passiert.",
      elementId: n.id,
    });
  }
}

function validateIntermediate(n: FlowNode, inc: Edge[], out: Edge[], add: (i: ValidationIssue) => void): void {
  const t = trigger(n);
  if (t === "error") {
    add({ rule: "event.intermediate-trigger", norm: N.intermediate, severity: "error", message: `Das Zwischenereignis „${label(n)}“ ist ein Fehler-Ereignis mitten im Ablauf.`, hint: "Fehler werden am Rand einer Aktivität gefangen (Rand-Ereignis) oder mit einem Fehler-Endereignis ausgelöst.", elementId: n.id });
  }
  if (t === "link") {
    if (inc.length && out.length) {
      add({ rule: "event.link-both", norm: N.intermediate, severity: "error", message: `Das Link-Ereignis „${label(n)}“ hat Ein- und Ausgang.`, hint: "Ein Link-Ereignis ist entweder Absprung (nur Eingang) oder Ziel (nur Ausgang).", elementId: n.id });
    }
    return;
  }
  if (!inc.length) {
    add({ rule: "event.intermediate-incoming", norm: N.intermediate, severity: "error", message: `Auf das Zwischenereignis „${label(n)}“ zeigt kein Pfeil.`, hint: "Ein Zwischenereignis im Ablauf braucht einen Vorgänger. Soll es eine laufende Aufgabe unterbrechen, als Rand-Ereignis an die Aufgabe hängen.", elementId: n.id });
  }
  if (!out.length) {
    add({ rule: "event.intermediate-outgoing", norm: N.intermediate, severity: "error", message: `Vom Zwischenereignis „${label(n)}“ geht kein Pfeil aus.`, hint: "Führe den Ablauf nach dem Ereignis weiter oder beende ihn mit einem Endereignis.", elementId: n.id });
  }
}

/** Link events (10.5.4): every jump has exactly one target of the same name. */
function validateLinks(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const links = Object.values(model.nodes).filter((n) => n.eventDefinition === "link");
  for (const n of links.filter((x) => x.type === "intermediateThrowEvent")) {
    const targets = links.filter((x) => x.type === "intermediateCatchEvent" && x.parent === n.parent && (x.name ?? "").trim() === (n.name ?? "").trim());
    if (targets.length !== 1) {
      add({
        rule: targets.length ? "event.link-ambiguous" : "event.link-target",
        norm: N.intermediate,
        severity: "error",
        message: targets.length
          ? `Zum Link „${label(n)}“ gibt es ${targets.length} Ziele mit demselben Namen.`
          : `Zum Link „${label(n)}“ gibt es kein Ziel mit demselben Namen.`,
        hint: "Jeder Link-Absprung braucht genau ein fangendes Link-Ereignis mit identischem Namen in derselben Ebene.",
        elementId: n.id,
        relatedIds: targets.map((x) => x.id),
      });
    }
  }
}

/** A process level with a start needs an end and vice versa (10.5.2 / 10.5.3). */
function validateStartEnd(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const scopes = new Set(Object.values(model.nodes).map((n) => n.parent));
  for (const scope of scopes) {
    const inScope = Object.values(model.nodes).filter((n) => n.parent === scope);
    const starts = inScope.filter((n) => n.type === "startEvent");
    const ends = inScope.filter((n) => n.type === "endEvent");
    const where = model.nodes[scope] ? ` im Teilprozess „${label(model.nodes[scope])}“` : "";
    if (starts.length && !ends.length) {
      add({ rule: "event.end-missing", norm: N.end, severity: "error", message: `Es gibt ein Startereignis, aber kein Endereignis${where}.`, hint: "Jeder Pfad endet in einem Endereignis – am Schluss ein Ende ergänzen.", elementId: starts[0].id });
    }
    if (ends.length && !starts.length && !model.nodes[scope]?.type.includes("subProcess")) {
      add({ rule: "event.start-missing", norm: N.start, severity: "error", message: `Es gibt ein Endereignis, aber kein Startereignis${where}.`, hint: "Ein Startereignis an den Anfang setzen und benennen, was den Prozess auslöst.", elementId: ends[0].id });
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
        norm: N.gateway,
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
        norm: N.sequenceFlow,
            severity: "error",
            message: `Ein paralleles Gateway („${label(n)}“) hat einen Ausgang mit Bedingung.`,
            hint: "Parallele Gateways führen IMMER alle Wege gleichzeitig aus – Bedingungen sind hier nicht erlaubt. Nutze ein exklusives Gateway, wenn du entscheiden willst.",
            elementId: e.id,
          });
      }
    }
    if (n.type === "eventBasedGateway") validateEventGateway(model, n, out, adj.incoming, add);
  }
}

/** Event-based gateway configuration (10.6.6). */
function validateEventGateway(model: BpmnModel, n: FlowNode, out: Edge[], incoming: Record<string, Edge[]>, add: (i: ValidationIssue) => void): void {
  const issue = (rule: string, message: string, hint: string, elementId = n.id) =>
    add({ rule, norm: N.eventGateway, severity: "error", message, hint, elementId });
  if (out.length < 2) issue("gateway.event-based-outgoing", `Das ereignisbasierte Gateway „${label(n)}“ hat weniger als zwei Ausgänge.`, "Es wartet auf das erste von mehreren Ereignissen – mindestens zwei Ausgänge mit je einem Ereignis modellieren.");
  for (const e of out) {
    if (e.condition) issue("gateway.event-based-condition", `Ein Ausgang des ereignisbasierten Gateways „${label(n)}“ hat eine Bedingung.`, "Hier entscheidet das eintreffende Ereignis, nicht eine Bedingung – Bedingung entfernen.", e.id);
  }
  const targets = out.map((e) => model.nodes[e.target]).filter((t): t is FlowNode => !!t);
  for (const t of targets) {
    const okEvent = t.type === "intermediateCatchEvent" && ["message", "timer", "signal", "conditional"].includes(trigger(t));
    if (!okEvent && t.type !== "receiveTask") {
      issue("gateway.event-based-targets", `Auf das ereignisbasierte Gateway „${label(n)}“ folgt „${label(t)}“ – kein passendes Ereignis.`, "Nach einem ereignisbasierten Gateway kommen nur fangende Nachrichten-, Zeit-, Signal- oder Bedingungsereignisse oder Empfangsaufgaben.");
    }
    if ((incoming[t.id] ?? []).length > 1) {
      issue("gateway.event-based-target-incoming", `„${label(t)}“ nach dem ereignisbasierten Gateway „${label(n)}“ hat weitere Eingänge.`, "Die Ereignisse nach dem Gateway dürfen nur vom Gateway aus erreicht werden – andere Pfeile auf ein eigenes Element davor umlenken.", t.id);
    }
    if (t.type === "receiveTask" && Object.values(model.nodes).some((b) => b.type === "boundaryEvent" && b.attachedToRef === t.id)) {
      issue("gateway.event-based-receive-boundary", `Die Empfangsaufgabe „${label(t)}“ nach einem ereignisbasierten Gateway hat ein Rand-Ereignis.`, "Rand-Ereignisse sind hier nicht erlaubt – das Ereignis als weiteren Ausgang des Gateways modellieren.", t.id);
    }
  }
  if (targets.some((t) => t.type === "receiveTask") && targets.some((t) => t.type === "intermediateCatchEvent" && trigger(t) === "message")) {
    issue("gateway.event-based-mixed", `Nach dem ereignisbasierten Gateway „${label(n)}“ stehen Nachrichten-Ereignisse und Empfangsaufgaben gemischt.`, "Entweder nur Nachrichten-Ereignisse oder nur Empfangsaufgaben verwenden.");
  }
}

/**
 * Style (no rule of the standard): a rework loop that jumps back in front of a
 * parallel split restarts every parallel branch, not only the part that has to
 * be redone — often unintended (orders placed twice, plans redone).
 */
function validateStyle(model: BpmnModel, add: (i: ValidationIssue) => void): void {
  const adj = anyScopeAdjacency(model);
  const reaches = (from: string, to: string) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === to) return true;
      for (const e of adj.outgoing[x] ?? []) if (!seen.has(e.target)) (seen.add(e.target), stack.push(e.target));
    }
    return false;
  };
  const splitAfter = (id: string): FlowNode | undefined => {
    // through unnamed XOR merges to a parallel split
    for (let cur = model.nodes[id], i = 0; cur && i < 4; i++) {
      const out = adj.outgoing[cur.id] ?? [];
      if (cur.type === "parallelGateway" && out.length > 1) return cur;
      if (cur.type !== "exclusiveGateway" || out.length !== 1) return undefined;
      cur = model.nodes[out[0].target];
    }
    return undefined;
  };
  const reported = new Set<string>();
  for (const e of Object.values(model.edges)) {
    if (e.type !== "sequenceFlow" || !model.nodes[e.source] || !model.nodes[e.target]) continue;
    const split = splitAfter(e.target);
    if (!split || reported.has(e.id) || !reaches(split.id, e.source)) continue;
    // only the jump back, not the regular way into the split
    const regular = (adj.incoming[e.target] ?? []).filter((x) => !reaches(split.id, x.source));
    if (!regular.length) continue;
    reported.add(e.id);
    const branches = (adj.outgoing[split.id] ?? []).length;
    const src = model.nodes[e.source];
    add({
      rule: "style.loop-restarts-parallel",
      style: true,
      severity: "info",
      message: `Der Rücksprung nach „${label(src)}“ startet alle ${branches} parallelen Zweige neu.`,
      hint: "Prüfe, ob wirklich alles wiederholt werden muss (z. B. Bestellungen). Sonst gezielt zu dem Schritt zurückspringen, der neu gemacht wird.",
      elementId: e.id,
      relatedIds: [split.id],
    });
  }
  // 8.4.13: a conditional flow out of an activity needs another way out
  for (const n of Object.values(model.nodes)) {
    if (!isActivity(n.type)) continue;
    const out = adj.outgoing[n.id] ?? [];
    if (out.length === 1 && out[0].condition) {
      add({ rule: "flow.condition-single", norm: N.sequenceFlow, severity: "warning", message: `Der einzige Ausgang von „${label(n)}“ hat eine Bedingung.`, hint: "Ist die Bedingung nicht erfüllt, bleibt der Ablauf stehen. Bedingung entfernen oder einen weiteren Ausgang (z. B. Standardfluss) ergänzen.", elementId: out[0].id });
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
