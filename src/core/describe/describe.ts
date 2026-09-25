import { BpmnModel, FlowNode, buildAdjacency, detectBackEdges } from "../model";
import { validate } from "../validation";

/**
 * Process description generated from the diagram (Q.wiki / Signavio style):
 * header data, triggers and outcomes, roles with their steps, a numbered step
 * table and open points.
 *
 * Deliberately deterministic: every sentence is derived from the model, so the
 * description can never claim something the diagram does not contain. Text
 * the diagram cannot know (purpose, scope, owner) is left as a visible
 * placeholder instead of being invented.
 */

export type StepKind =
  | "start"
  | "end"
  | "activity"
  | "decision"
  | "merge"
  | "parallel-split"
  | "parallel-join"
  | "inclusive-split"
  | "inclusive-join"
  | "event-split"
  | "wait"
  | "event";

export interface StepLink {
  /** branch condition, if any. */
  label?: string;
  no: number;
  name: string;
  /** flow returns to an earlier step (rework loop). */
  loop: boolean;
}

export interface DescriptionStep {
  no: number;
  id: string;
  kind: StepKind;
  name: string;
  /** German type label, e.g. "Benutzeraufgabe". */
  typeLabel: string;
  role: string;
  /** generated explanation of what happens in this step. */
  description: string;
  /** text entered in the element's documentation field. */
  documentation?: string;
  next: StepLink[];
}

export interface ProcessDescription {
  title: string;
  /** header fields the diagram cannot know — shown as placeholders to fill in. */
  header: { label: string; value: string }[];
  /** YYYY-MM-DD */
  date: string;
  /** "Ablauf in Kürze" prose. */
  summary: string;
  /** main path from the start to the first outcome. */
  mainPath: string[];
  triggers: string[];
  outcomes: string[];
  roles: { name: string; steps: { no: number; name: string }[] }[];
  stats: { steps: number; activities: number; decisions: number; parallel: number; loops: number; roles: number };
  steps: DescriptionStep[];
  openPoints: string[];
}

export interface DescribeOptions {
  /** extra open points, e.g. AI ambiguities. */
  extraOpenPoints?: string[];
  date?: Date;
}

const PLACEHOLDER = "(bitte ergänzen)";

export function describeProcess(model: BpmnModel, opts: DescribeOptions = {}): ProcessDescription {
  const scope = model.rootProcessId;
  const nodes = Object.values(model.nodes).filter(
    (n) => n.parent === scope && n.type !== "textAnnotation" && n.type !== "dataObjectReference" && n.type !== "dataStoreReference",
  );
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const seq = Object.values(model.edges).filter((e) => e.type === "sequenceFlow" && byId[e.source] && byId[e.target]);
  const adj = buildAdjacency(model, { scope, types: ["sequenceFlow"] });
  const back = detectBackEdges(adj);
  const outs = (id: string) => seq.filter((e) => e.source === id);
  const ins = (id: string) => seq.filter((e) => e.target === id);

  const laneName = (n: FlowNode) => (n.lane && model.lanes[n.lane]?.name) || "";
  const roleOf = (n: FlowNode): string => {
    if (n.type === "boundaryEvent" && n.attachedToRef && byId[n.attachedToRef]) return laneName(byId[n.attachedToRef]) || "—";
    return laneName(n) || "—";
  };

  // --- Numbering: topological order, finishing one branch before the next, joins after all their branches.
  const order: FlowNode[] = [];
  const indeg: Record<string, number> = {};
  for (const n of nodes) indeg[n.id] = ins(n.id).filter((e) => !back.has(e.id)).length;
  const posKey = (n: FlowNode) => n.bounds.y * 10000 + n.bounds.x;
  const stack = nodes
    .filter((n) => n.type !== "boundaryEvent" && indeg[n.id] === 0)
    .sort((a, b) => (a.type === "startEvent" ? 0 : 1) - (b.type === "startEvent" ? 0 : 1) || posKey(b) - posKey(a));
  const done = new Set<string>();
  const emit = (n: FlowNode) => {
    if (done.has(n.id)) return;
    done.add(n.id);
    order.push(n);
    // boundary events directly after their host
    for (const b of nodes.filter((x) => x.type === "boundaryEvent" && x.attachedToRef === n.id)) {
      done.add(b.id);
      order.push(b);
      for (const e of outs(b.id)) if (!back.has(e.id) && --indeg[e.target] === 0) stack.push(byId[e.target]);
    }
  };
  while (stack.length) {
    const n = stack.pop()!;
    emit(n);
    // Pushed last = numbered next: topmost branch first, but a branch that
    // ends right away (e.g. "abgelehnt") is numbered before the long ones.
    const succ = outs(n.id)
      .filter((e) => !back.has(e.id))
      .map((e) => byId[e.target])
      .sort((a, b) => (a.type === "endEvent" ? 1 : 0) - (b.type === "endEvent" ? 1 : 0) || posKey(b) - posKey(a));
    for (const t of succ) if (--indeg[t.id] === 0) stack.push(t);
  }
  for (const n of nodes) if (!done.has(n.id)) emit(n); // unreachable leftovers
  const noOf: Record<string, number> = {};
  order.forEach((n, i) => (noOf[n.id] = i + 1));

  // --- Steps
  const kindOf: Record<string, StepKind> = {};
  const nameOf: Record<string, string> = {};
  for (const n of order) {
    kindOf[n.id] = stepKind(n, outs(n.id).length, ins(n.id).length);
    nameOf[n.id] = n.name?.trim() ? displayName(n) : `(${typeLabel(n, kindOf[n.id])})`;
  }
  const steps: DescriptionStep[] = order.map((n) => {
    const kind = kindOf[n.id];
    const next: StepLink[] = outs(n.id)
      .map((e) => ({ label: e.name || undefined, no: noOf[e.target], name: nameOf[e.target], loop: back.has(e.id) || noOf[e.target] <= noOf[n.id] }))
      .sort((a, b) => a.no - b.no);
    const prev = ins(n.id).map((e) => noOf[e.source]).sort((a, b) => a - b);
    return {
      no: noOf[n.id],
      id: n.id,
      kind,
      name: nameOf[n.id],
      typeLabel: typeLabel(n, kind),
      role: roleOf(n),
      description: explain(n, kind, roleOf(n), next, prev, byId, noOf),
      documentation: n.documentation?.trim() || undefined,
      next,
    };
  });

  // --- Overview
  const starts = order.filter((n) => n.type === "startEvent");
  const ends = order.filter((n) => n.type === "endEvent");
  const activities = steps.filter((s) => s.kind === "activity");
  const decisions = steps.filter((s) => s.kind === "decision" || s.kind === "inclusive-split" || s.kind === "event-split");
  const parallel = steps.filter((s) => s.kind === "parallel-split");
  const loops = seq.filter((e) => back.has(e.id));

  const roleNames = Object.values(model.lanes)
    .filter((l) => nodes.some((n) => n.lane === l.id))
    .map((l) => l.name || "Unbenannte Rolle");
  const roles = roleNames.map((name) => ({
    name,
    steps: steps.filter((s) => s.role === name && s.kind === "activity").map((s) => ({ no: s.no, name: s.name })),
  }));

  const mainPath = followMainPath(starts[0], outs, byId, back);
  const title = model.processes[scope]?.name || model.name || Object.values(model.participants)[0]?.name || "Prozess";
  const summary = buildSummary(title, starts, ends, roleNames, activities.length, decisions.length, parallel.length, loops.length);

  // --- Open points
  const openPoints: string[] = [];
  for (const s of steps) {
    const unnamed = !model.nodes[s.id].name?.trim();
    if (unnamed && (s.kind === "activity" || s.kind === "decision" || s.kind === "start" || s.kind === "end")) {
      openPoints.push(`Schritt ${s.no} (${s.typeLabel}) hat keinen Namen.`);
    }
  }
  const undocumented = activities.filter((s) => !s.documentation).length;
  if (activities.length && undocumented) {
    openPoints.push(`${undocumented} von ${activities.length} Aktivitäten haben noch keine Beschreibung im Feld „Dokumentation“.`);
  }
  for (const issue of validate(model)) {
    if (issue.severity === "info") continue;
    const at = issue.elementId && noOf[issue.elementId] ? `Schritt ${noOf[issue.elementId]}: ` : "";
    openPoints.push(`${at}${issue.message}`);
  }
  openPoints.push(...(opts.extraOpenPoints ?? []));

  return {
    title,
    header: [
      { label: "Zweck", value: PLACEHOLDER },
      { label: "Geltungsbereich", value: PLACEHOLDER },
      { label: "Prozessverantwortlich", value: PLACEHOLDER },
      { label: "Version / Freigabe", value: PLACEHOLDER },
    ],
    date: (opts.date ?? new Date()).toISOString().slice(0, 10),
    summary,
    mainPath,
    triggers: starts.map((s) => `${displayName(s)}${eventSuffix(s)}`),
    outcomes: ends.map((e) => displayName(e)),
    roles,
    stats: {
      steps: steps.length,
      activities: activities.length,
      decisions: decisions.length,
      parallel: parallel.length,
      loops: loops.length,
      roles: roleNames.length,
    },
    steps,
    openPoints,
  };
}

function stepKind(n: FlowNode, outCount: number, inCount: number): StepKind {
  switch (n.type) {
    case "startEvent":
      return "start";
    case "endEvent":
      return "end";
    case "exclusiveGateway":
    case "complexGateway":
      return outCount > 1 ? "decision" : "merge";
    case "parallelGateway":
      return outCount > 1 ? "parallel-split" : "parallel-join";
    case "inclusiveGateway":
      return outCount > 1 ? "inclusive-split" : "inclusive-join";
    case "eventBasedGateway":
      return "event-split";
    case "intermediateCatchEvent":
      return "wait";
    case "intermediateThrowEvent":
    case "boundaryEvent":
      return "event";
    default:
      void inCount;
      return "activity";
  }
}

function displayName(n: FlowNode): string {
  return n.name?.trim() ? n.name.trim().replace(/\s+/g, " ") : "(ohne Namen)";
}

const TYPE_LABELS: Record<string, string> = {
  task: "Aufgabe",
  userTask: "Benutzeraufgabe",
  manualTask: "Manuelle Tätigkeit",
  serviceTask: "Automatisiert (System)",
  scriptTask: "Skript",
  sendTask: "Nachricht senden",
  receiveTask: "Nachricht empfangen",
  businessRuleTask: "Geschäftsregel",
  subProcess: "Teilprozess",
  callActivity: "Aufruf Teilprozess",
};

function typeLabel(n: FlowNode, kind: StepKind): string {
  switch (kind) {
    case "start":
      return "Start";
    case "end":
      return "Ende";
    case "decision":
      return "Entscheidung";
    case "merge":
      return "Zusammenführung";
    case "parallel-split":
      return "Parallelisierung";
    case "parallel-join":
      return "Synchronisation";
    case "inclusive-split":
      return "Oder-Verzweigung";
    case "inclusive-join":
      return "Oder-Zusammenführung";
    case "event-split":
      return "Ereignis-Verzweigung";
    case "wait":
      return n.eventDefinition === "timer" ? "Warten (Zeit)" : n.eventDefinition === "message" ? "Warten (Nachricht)" : "Zwischenereignis";
    case "event":
      return n.type === "boundaryEvent" ? "Angeheftetes Ereignis" : "Zwischenereignis";
    default:
      return TYPE_LABELS[n.type] ?? "Aufgabe";
  }
}

function eventSuffix(n: FlowNode): string {
  switch (n.eventDefinition) {
    case "message":
      return " (Nachricht)";
    case "timer":
      return " (Zeitpunkt)";
    case "signal":
      return " (Signal)";
    case "conditional":
      return " (Bedingung)";
    default:
      return "";
  }
}

const list = (xs: string[], and = "und") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs[xs.length - 1]}`);
const refs = (links: StepLink[]) => list(links.map((l) => `${l.no} (${l.name})`));

function explain(
  n: FlowNode,
  kind: StepKind,
  role: string,
  next: StepLink[],
  prev: number[],
  byId: Record<string, FlowNode>,
  noOf: Record<string, number>,
): string {
  const who = role !== "—" ? role : "";
  switch (kind) {
    case "start":
      return `Der Prozess beginnt mit dem Ereignis „${displayName(n)}“${eventSuffix(n)}.`;
    case "end":
      return `Der Prozess endet mit dem Ergebnis „${displayName(n)}“.`;
    case "decision": {
      const branches = next.map((l) => `${l.label ? `bei „${l.label}“` : "sonst"} weiter mit Schritt ${l.no}${l.loop ? " (Rücksprung)" : ""}`);
      return `${who ? `${who} entscheidet` : "Entscheidung"}: ${displayName(n)} – ${list(branches)}.`;
    }
    case "merge":
      return `Die alternativen Pfade aus Schritt ${list(prev.map(String))} werden zusammengeführt.`;
    case "parallel-split":
      return `Die Schritte ${refs(next)} laufen parallel.`;
    case "parallel-join":
      return `Wartet, bis alle parallelen Pfade (aus Schritt ${list(prev.map(String))}) abgeschlossen sind.`;
    case "inclusive-split":
      return `Je nach Bedingung werden einer oder mehrere der folgenden Pfade durchlaufen: ${list(next.map((l) => `${l.label ? `„${l.label}“ → ` : ""}Schritt ${l.no}`))}.`;
    case "inclusive-join":
      return `Wartet auf alle aktivierten Pfade (aus Schritt ${list(prev.map(String))}).`;
    case "event-split":
      return `Es wird auf das zuerst eintretende Ereignis gewartet: ${list(next.map((l) => `„${l.name}“ (Schritt ${l.no})`), "oder")}.`;
    case "wait":
      return n.eventDefinition === "timer"
        ? `Der Prozess wartet, bis „${displayName(n)}“ eintritt.`
        : `Der Prozess wartet auf „${displayName(n)}“.`;
    case "event":
      if (n.type === "boundaryEvent" && n.attachedToRef && byId[n.attachedToRef]) {
        return `Tritt während Schritt ${noOf[n.attachedToRef]} (${displayName(byId[n.attachedToRef])}) „${displayName(n)}“ ein, geht es mit ${next.length ? `Schritt ${next[0].no}` : "dem Ereignis"} weiter${n.cancelActivity === false ? " (ohne Abbruch)" : ""}.`;
      }
      return `Ereignis „${displayName(n)}“ wird ausgelöst.`;
    default:
      // Only say what the table columns don't already say; no filler text.
      switch (n.type) {
        case "serviceTask":
        case "scriptTask":
          return "Läuft automatisiert im System.";
        case "manualTask":
          return "Manuelle (physische) Tätigkeit.";
        case "sendTask":
          return "Versand einer Nachricht.";
        case "receiveTask":
          return "Wartet auf eine eingehende Nachricht.";
        case "businessRuleTask":
          return "Auswertung einer Geschäftsregel.";
        default:
          return who ? "" : "Keine Rolle zugeordnet.";
      }
  }
}

/** Follow the "happy path": first/yes branch at each decision, no loops. */
function followMainPath(
  start: FlowNode | undefined,
  outs: (id: string) => { id: string; target: string; name?: string }[],
  byId: Record<string, FlowNode>,
  back: Set<string>,
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur = start;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type !== "exclusiveGateway" && cur.type !== "parallelGateway" && cur.type !== "inclusiveGateway" && cur.type !== "eventBasedGateway") {
      path.push(displayName(cur));
    }
    const candidates = outs(cur.id).filter((e) => !back.has(e.id));
    const yes = candidates.find((e) => /^(ja|yes|ok|freigegeben|genehmigt|approved)$/i.test(e.name ?? ""));
    const pick = yes ?? candidates.find((e) => !/^(nein|no|abgelehnt|rejected)$/i.test(e.name ?? "")) ?? candidates[0];
    cur = pick ? byId[pick.target] : undefined;
  }
  return path;
}

function buildSummary(
  title: string,
  starts: FlowNode[],
  ends: FlowNode[],
  roles: string[],
  activities: number,
  decisions: number,
  parallel: number,
  loops: number,
): string {
  const parts: string[] = [];
  parts.push(
    starts.length
      ? `Der Prozess „${title}“ beginnt mit ${starts.length > 1 ? "einem der Ereignisse" : "dem Ereignis"} ${list(starts.map((s) => `„${displayName(s)}“`))}.`
      : `Für den Prozess „${title}“ ist kein Startereignis modelliert.`,
  );
  if (roles.length) parts.push(`Beteiligt ${roles.length > 1 ? "sind" : "ist"} ${list(roles)}.`);
  const struct = [`${activities} Aktivität${activities === 1 ? "" : "en"}`, `${decisions} Entscheidung${decisions === 1 ? "" : "en"}`];
  if (parallel) struct.push(`${parallel} parallele${parallel === 1 ? "r" : ""} Abschnitt${parallel === 1 ? "" : "e"}`);
  if (loops) struct.push(`${loops} Rücksprung${loops === 1 ? "" : "e"}`);
  parts.push(`Er umfasst ${list(struct)}.`);
  if (ends.length) {
    parts.push(`${ends.length > 1 ? "Mögliche Ergebnisse sind" : "Das Ergebnis ist"} ${list(ends.map((e) => `„${displayName(e)}“`))}.`);
  }
  return parts.join(" ");
}
