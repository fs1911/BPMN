import type { BpmnModel, Edge, FlowNode } from "../model";

/**
 * What changed between two saved states of one process, by element id (ids
 * are stable across edits, AI edits included). Layout moves are not counted:
 * they change after every "Diagramm aufräumen" and say nothing about the
 * process itself.
 */

export interface ElementChange {
  id: string;
  /** e.g. "Name: „Antrag prüfen“ → „Antrag fachlich prüfen“" */
  details: string[];
}

export interface ModelDiff {
  /** only in the newer state */
  added: string[];
  /** only in the older state */
  removed: string[];
  changed: ElementChange[];
  /** German change list for the user */
  lines: string[];
}

const SKIP = new Set(["textAnnotation"]);

const TYPE_NAME: Record<string, string> = {
  startEvent: "Startereignis",
  endEvent: "Endereignis",
  intermediateThrowEvent: "Zwischenereignis",
  intermediateCatchEvent: "Zwischenereignis",
  boundaryEvent: "Randereignis",
  task: "Aufgabe",
  userTask: "Benutzeraufgabe",
  serviceTask: "Serviceaufgabe",
  scriptTask: "Skriptaufgabe",
  sendTask: "Sendeaufgabe",
  receiveTask: "Empfangsaufgabe",
  manualTask: "Manuelle Aufgabe",
  businessRuleTask: "Geschäftsregelaufgabe",
  subProcess: "Teilprozess",
  callActivity: "Aufrufaktivität",
  exclusiveGateway: "XOR-Gateway",
  parallelGateway: "Paralleles Gateway",
  inclusiveGateway: "ODER-Gateway",
  eventBasedGateway: "Ereignis-Gateway",
  complexGateway: "Komplexes Gateway",
  dataObjectReference: "Datenobjekt",
  dataStoreReference: "Datenspeicher",
};

const q = (s?: string) => (s?.trim() ? `„${s.trim().replace(/\s+/g, " ")}“` : "–");

export function diffModels(older: BpmnModel, newer: BpmnModel): ModelDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ElementChange[] = [];
  const lines: string[] = [];
  const nodeLabel = (n: FlowNode) => `${TYPE_NAME[n.type] ?? n.type} ${q(n.name)}`.replace(/ –$/, "");
  const laneName = (m: BpmnModel, id?: string) => (id ? m.lanes[id]?.name : undefined);
  const endName = (m: BpmnModel, id: string) => q(m.nodes[id]?.name || m.participants[id]?.name || TYPE_NAME[m.nodes[id]?.type ?? ""]);
  const flowLabel = (m: BpmnModel, e: Edge) => `${e.type === "messageFlow" ? "Nachricht" : "Verbindung"} ${endName(m, e.source)} → ${endName(m, e.target)}${e.name ? ` (${q(e.name)})` : ""}`;

  const nodesOf = (m: BpmnModel) => new Map(Object.values(m.nodes).filter((n) => !SKIP.has(n.type)).map((n) => [n.id, n]));
  const a = nodesOf(older);
  const b = nodesOf(newer);
  for (const [id, n] of b) if (!a.has(id)) (added.push(id), lines.push(`Neu: ${nodeLabel(n)}`));
  for (const [id, n] of a) if (!b.has(id)) (removed.push(id), lines.push(`Entfernt: ${nodeLabel(n)}`));
  for (const [id, nb] of b) {
    const na = a.get(id);
    if (!na) continue;
    const d: string[] = [];
    if ((na.name ?? "").trim() !== (nb.name ?? "").trim()) d.push(`Name: ${q(na.name)} → ${q(nb.name)}`);
    if (na.type !== nb.type) d.push(`Art: ${TYPE_NAME[na.type] ?? na.type} → ${TYPE_NAME[nb.type] ?? nb.type}`);
    if ((laneName(older, na.lane) ?? "") !== (laneName(newer, nb.lane) ?? "")) d.push(`Zuständig: ${q(laneName(older, na.lane))} → ${q(laneName(newer, nb.lane))}`);
    if ((na.eventDefinition ?? "none") !== (nb.eventDefinition ?? "none")) d.push(`Ereignisart: ${na.eventDefinition ?? "keine"} → ${nb.eventDefinition ?? "keine"}`);
    if ((na.documentation ?? "") !== (nb.documentation ?? "")) d.push("Dokumentation geändert");
    if (d.length) {
      changed.push({ id, details: d });
      lines.push(`Geändert: ${nodeLabel(nb)} – ${d.join("; ")}`);
    }
  }

  const flowsOf = (m: BpmnModel) => new Map(Object.values(m.edges).filter((e) => e.type !== "association").map((e) => [e.id, e]));
  const fa = flowsOf(older);
  const fb = flowsOf(newer);
  // Connections are matched by id, or else by "same kind, same from → to": AI
  // edits and other tools may renumber connections without changing them.
  const pairs = new Map<string, string>(); // newer id → older id
  for (const id of fb.keys()) if (fa.has(id)) pairs.set(id, id);
  const ends = (e: Edge) => `${e.type}|${e.source}|${e.target}`;
  const pool = new Map<string, Edge[]>();
  for (const [id, e] of fa) if (!fb.has(id)) (pool.get(ends(e)) ?? pool.set(ends(e), []).get(ends(e))!).push(e);
  for (const [id, e] of fb) {
    if (pairs.has(id)) continue;
    const cands = pool.get(ends(e));
    if (!cands?.length) continue;
    const i = Math.max(0, cands.findIndex((c) => (c.name ?? "") === (e.name ?? "")));
    pairs.set(id, cands.splice(i, 1)[0].id);
  }
  const pairedOld = new Set(pairs.values());
  for (const [id, e] of fb) if (!pairs.has(id)) (added.push(id), lines.push(`Neu: ${flowLabel(newer, e)}`));
  for (const [id, e] of fa) if (!pairedOld.has(id)) (removed.push(id), lines.push(`Entfernt: ${flowLabel(older, e)}`));
  for (const [id, eb] of fb) {
    const ea = pairs.has(id) ? fa.get(pairs.get(id)!) : undefined;
    if (!ea) continue;
    const d: string[] = [];
    if (ea.source !== eb.source || ea.target !== eb.target) d.push(`neu verbunden: ${endName(older, ea.source)} → ${endName(older, ea.target)} wird ${endName(newer, eb.source)} → ${endName(newer, eb.target)}`);
    if ((ea.name ?? "") !== (eb.name ?? "")) d.push(`Beschriftung: ${q(ea.name)} → ${q(eb.name)}`);
    if (!!ea.isDefault !== !!eb.isDefault) d.push(eb.isDefault ? "ist jetzt Standardpfad" : "ist kein Standardpfad mehr");
    if (d.length) {
      // ids differ when renumbered: mark the connection in both versions
      changed.push({ id, details: d });
      if (ea.id !== id) changed.push({ id: ea.id, details: d });
      lines.push(`Geändert: ${flowLabel(newer, eb)} – ${d.join("; ")}`);
    }
  }

  const lanesA = new Map(Object.values(older.lanes).map((l) => [l.id, l]));
  const lanesB = new Map(Object.values(newer.lanes).map((l) => [l.id, l]));
  for (const [id, l] of lanesB) {
    const o = lanesA.get(id);
    if (!o) lines.push(`Neue Bahn: ${q(l.name)}`);
    else if ((o.name ?? "") !== (l.name ?? "")) lines.push(`Bahn umbenannt: ${q(o.name)} → ${q(l.name)}`);
  }
  for (const [id, l] of lanesA) if (!lanesB.has(id)) lines.push(`Bahn entfernt: ${q(l.name)}`);

  return { added, removed, changed, lines };
}
