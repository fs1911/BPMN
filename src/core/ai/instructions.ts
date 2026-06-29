import { autoLayout } from "../layout";
import {
  BpmnModel,
  Edge,
  FlowElementType,
  FlowNode,
  createEdge,
  createLane,
  createNode,
} from "../model";
import { ValidationIssue, validate } from "../validation";

/**
 * Instruction → model update.
 *
 * Follow-up natural-language commands are parsed into typed operations that
 * mutate the existing model in place, then the model is re-validated, re-routed
 * and re-laid-out. This is the "instruction to model update" capability: the
 * diagram keeps its identity while the change is applied semantically (not by
 * regenerating from scratch).
 */

export interface InstructionResult {
  applied: boolean;
  description: string;
  assumptions: string[];
  issues: ValidationIssue[];
  affected: string[];
}

type Op = (model: BpmnModel, res: InstructionResult) => void;

export function applyInstruction(model: BpmnModel, instruction: string): InstructionResult {
  const res: InstructionResult = { applied: false, description: "", assumptions: [], issues: [], affected: [] };
  const text = instruction.trim();
  const op = parseInstruction(text);
  if (!op) {
    res.description = isGerman(text)
      ? `Konnte „${instruction}“ nicht interpretieren. Versuchen Sie z. B. „Eine Freigabe durch den Manager vor dem Versand hinzufügen“.`
      : `Could not interpret: "${instruction}". Try e.g. "Add an approval by the manager before shipment".`;
    return res;
  }
  op(model, res);
  if (res.applied) {
    res.issues = validate(model);
    autoLayout(model, model.rootProcessId);
  }
  return res;
}

/** True if the instruction looks German. */
function isGerman(text: string): boolean {
  return /\b(hinzufüg\w*|füge|ersetze|verschieb\w*|benenne|aufteil\w*|bahn\w*|spur\w*|freigab\w*|genehmig\w*|ausnahme\w*|schleife|nacharbeit\w*|prüfung|vor|nach|durch|wenn|fehlt)\b|[äöüß]/i.test(text);
}

/** Resolve an operation from the instruction text (bilingual). Order matters. */
function parseInstruction(text: string): Op | null {
  const t = text.toLowerCase();

  if (/\bsplit\b.*\b(lane|lanes)\b/.test(t) || /separate lanes?/.test(t) || /\b(bahnen?|spuren?)\b/.test(t) || /(aufteil\w*|trenn\w*).*(bahn|spur|lane)/.test(t)) {
    const names = extractLaneNames(text);
    return (m, r) => splitLanes(m, r, names);
  }
  if (/\b(rework|loop)\b/.test(t) || /send back|return to/.test(t) || /\b(schleife|nacharbeit\w*|zurück\w*)\b/.test(t)) {
    return (m, r) => addReworkLoop(m, r, text);
  }
  if (/exception (path|branch)|if .* (missing|fails|invalid|not)/.test(t) || /ausnahme\w*/.test(t) || /wenn .* (fehlt|fehlend|ungültig|scheiter|nicht)/.test(t)) {
    return (m, r) => addExceptionPath(m, r, text);
  }
  if (/replace\b/.test(t) || /\bersetze\w*\b/.test(t)) {
    return (m, r) => replaceNode(m, r, text);
  }
  if (/\bmove\b/.test(t) || /\bverschieb\w*\b/.test(t)) {
    return (m, r) => moveBefore(m, r, text);
  }
  if (/rename\b/.test(t) || /\bbenenne\b|umbenenn\w*/.test(t)) {
    return (m, r) => rename(m, r, text);
  }
  if (/add (an? )?approval|approval by/.test(t) || /\b(freigab\w*|genehmig\w*)\b/.test(t)) {
    return (m, r) => addApproval(m, r, text);
  }
  if (/add (an? )?(check|review|verification)/.test(t) || /\b(prüfung|prüf\w*|kontrolle|überprüf\w*)\b/.test(t)) {
    return (m, r) => addActivity(m, r, text, "userTask");
  }
  if (/add (an? )?(task|step|activity)/.test(t) || /\b(aufgabe|schritt|aktivität)\b/.test(t)) {
    return (m, r) => addActivity(m, r, text, "task");
  }
  return null;
}

// ---------- node lookup helpers ----------

function findNodeByText(model: BpmnModel, phrase: string): FlowNode | undefined {
  const p = phrase.toLowerCase().trim();
  if (!p) return undefined;
  let best: FlowNode | undefined;
  let bestScore = 0;
  for (const n of Object.values(model.nodes)) {
    if (!n.name) continue;
    const name = n.name.toLowerCase();
    let score = 0;
    if (name === p) score = 100;
    else if (name.includes(p) || p.includes(name)) score = 60;
    else {
      const words = p.split(/\s+/).filter((w) => w.length > 2);
      score = words.filter((w) => name.includes(w)).length * 15;
    }
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return bestScore >= 15 ? best : undefined;
}

function firstEndEvent(model: BpmnModel): FlowNode | undefined {
  return Object.values(model.nodes).find((n) => n.type === "endEvent");
}

function incomingEdges(model: BpmnModel, nodeId: string): Edge[] {
  return Object.values(model.edges).filter((e) => e.type === "sequenceFlow" && e.target === nodeId);
}
function outgoingEdges(model: BpmnModel, nodeId: string): Edge[] {
  return Object.values(model.edges).filter((e) => e.type === "sequenceFlow" && e.source === nodeId);
}

/** Insert a single new node onto every incoming edge of an anchor node. */
function spliceBefore(model: BpmnModel, anchor: FlowNode, newNode: FlowNode): void {
  const incs = incomingEdges(model, anchor.id);
  if (!incs.length) {
    createEdge(model, "sequenceFlow", newNode.id, anchor.id);
    return;
  }
  for (const e of incs) {
    e.target = newNode.id;
  }
  createEdge(model, "sequenceFlow", newNode.id, anchor.id);
}

function laneFor(model: BpmnModel, role: string | undefined, sample?: FlowNode): string | undefined {
  if (role) {
    const existing = Object.values(model.lanes).find(
      (l) => l.name && l.name.toLowerCase() === role.toLowerCase(),
    );
    if (existing) return existing.id;
    if (Object.values(model.lanes).length) {
      const lane = createLane(model, { name: capitalize(role), parent: model.rootProcessId });
      return lane.id;
    }
  }
  return sample?.lane;
}

// ---------- operations ----------

function addApproval(model: BpmnModel, res: InstructionResult, text: string): void {
  const de = isGerman(text);
  const role = extractRole(text);
  const anchor = resolveAnchor(model, text) ?? firstEndEvent(model);
  if (!anchor) {
    res.description = de ? "Keine Einfügestelle für die Freigabe gefunden." : "No place found to insert the approval.";
    return;
  }
  const obj = extractObject(text) ?? (de ? "Anforderung" : "request");
  const task = createNode(model, "userTask", { name: de ? `${capitalize(obj)} freigeben` : `Approve ${obj}` });
  const gw = createNode(model, "exclusiveGateway", { name: de ? "Freigegeben?" : "Approved?" });
  const lane = laneFor(model, role, anchor);
  if (lane) {
    for (const n of [task, gw]) {
      n.lane = lane;
      pushRef(model, lane, n.id);
    }
  }
  // splice task before anchor, then gateway between task and anchor
  spliceBefore(model, anchor, task);
  // redirect task->anchor edge through the gateway
  const taskOut = outgoingEdges(model, task.id).find((e) => e.target === anchor.id);
  if (taskOut) taskOut.target = gw.id;
  createEdge(model, "sequenceFlow", gw.id, anchor.id, { name: de ? "freigegeben" : "approved", condition: "${approved}" });
  const reject = createNode(model, "endEvent", { name: de ? "Anforderung abgelehnt" : "Request rejected" });
  if (lane) {
    reject.lane = lane;
    pushRef(model, lane, reject.id);
  }
  createEdge(model, "sequenceFlow", gw.id, reject.id, { name: de ? "abgelehnt" : "rejected", condition: "${rejected}", isDefault: true });

  res.applied = true;
  res.affected = [task.id, gw.id, reject.id];
  res.description = de
    ? `Freigabe „${task.name}“${role ? ` durch ${capitalize(role)}` : ""} vor „${anchor.name ?? anchor.id}“ ergänzt, mit Verzweigung freigegeben/abgelehnt.`
    : `Added approval "${task.name}"${role ? ` by ${capitalize(role)}` : ""} before "${anchor.name ?? anchor.id}", with approved/rejected branches.`;
  if (role) res.assumptions.push(de ? `Freigabe der Bahn „${capitalize(role)}“ zugeordnet.` : `Assigned the approval to a "${capitalize(role)}" lane.`);
}

function addActivity(model: BpmnModel, res: InstructionResult, text: string, type: FlowElementType): void {
  const de = isGerman(text);
  const role = extractRole(text);
  const anchor = resolveAnchor(model, text) ?? firstEndEvent(model);
  if (!anchor) {
    res.description = de ? "Keine Einfügestelle für die Aktivität gefunden." : "No place found to insert the activity.";
    return;
  }
  const name = extractActivityName(text) ?? (de ? "Neuer Schritt" : "New step");
  const node = createNode(model, type, { name });
  const lane = laneFor(model, role, anchor);
  if (lane) {
    node.lane = lane;
    pushRef(model, lane, node.id);
  }
  spliceBefore(model, anchor, node);
  res.applied = true;
  res.affected = [node.id];
  res.description = de
    ? `${type} „${name}“ vor „${anchor.name ?? anchor.id}“ ergänzt.`
    : `Added ${type} "${name}" before "${anchor.name ?? anchor.id}".`;
}

function addReworkLoop(model: BpmnModel, res: InstructionResult, text: string): void {
  const de = isGerman(text);
  // from = a check/gateway near the end of the "from" phrase; to = earlier task
  const { fromPhrase, toPhrase } = splitFromTo(text);
  let from = fromPhrase ? findNodeByText(model, fromPhrase) : undefined;
  const to = toPhrase ? findNodeByText(model, toPhrase) : undefined;

  // Default: loop the last gateway/check back to the preceding task.
  if (!from) {
    from = [...Object.values(model.nodes)].reverse().find((n) => n.type.endsWith("Gateway") || /check|review|verify/i.test(n.name ?? ""));
  }
  let target = to;
  if (!target && from) {
    const inc = incomingEdges(model, from.id)[0];
    target = inc ? model.nodes[inc.source] : undefined;
  }
  if (!from || !target) {
    res.description = de
      ? "Konnte kein Gateway/keine Prüfung und kein Zielschritt für die Schleife finden."
      : "Could not locate a gateway/check and a target step for the rework loop.";
    return;
  }
  // ensure a gateway exists to branch the loop from
  let gw = from;
  if (!from.type.endsWith("Gateway")) {
    gw = createNode(model, "exclusiveGateway", { name: de ? "Vollständig?" : "Complete?" });
    if (from.lane) {
      gw.lane = from.lane;
      pushRef(model, from.lane, gw.id);
    }
    const outs = outgoingEdges(model, from.id);
    for (const e of outs) e.source = gw.id;
    createEdge(model, "sequenceFlow", from.id, gw.id);
    res.affected.push(gw.id);
  }
  const cond = extractCondition(text) ?? (de ? "unvollständig" : "incomplete");
  const e = createEdge(model, "sequenceFlow", gw.id, target.id, { name: cond, condition: `\${${slug(cond)}}` });
  res.applied = true;
  res.affected.push(e.id);
  res.description = de
    ? `Nachbearbeitungsschleife erstellt: „${gw.name ?? gw.id}“ kehrt bei „${cond}“ zu „${target.name ?? target.id}“ zurück.`
    : `Created a rework loop: "${gw.name ?? gw.id}" returns to "${target.name ?? target.id}" when ${cond}.`;
}

function addExceptionPath(model: BpmnModel, res: InstructionResult, text: string): void {
  const de = isGerman(text);
  const anchor = resolveAnchor(model, text) ?? Object.values(model.nodes).find((n) => n.type.endsWith("Task"));
  if (!anchor) {
    res.description = de ? "Keine Aktivität gefunden, an die der Ausnahmepfad angehängt werden kann." : "No activity found to attach the exception path to.";
    return;
  }
  const cond = extractCondition(text) ?? (de ? "Ausnahme" : "exception");
  const gw = createNode(model, "exclusiveGateway", { name: `${capitalize(cond)}?` });
  if (anchor.lane) {
    gw.lane = anchor.lane;
    pushRef(model, anchor.lane, gw.id);
  }
  // splice gateway after anchor
  const outs = outgoingEdges(model, anchor.id);
  const continueTarget = outs[0]?.target;
  for (const e of outs) e.source = gw.id;
  createEdge(model, "sequenceFlow", anchor.id, gw.id);
  if (continueTarget) {
    const okEdge = outgoingEdges(model, gw.id).find((e) => e.target === continueTarget);
    if (okEdge) {
      okEdge.name = "ok";
      okEdge.condition = "${ok}";
    }
  }
  const excEnd = createNode(model, "endEvent", { name: capitalize(cond) + (de ? " behandelt" : " handled"), eventDefinition: "error" });
  if (anchor.lane) {
    excEnd.lane = anchor.lane;
    pushRef(model, anchor.lane, excEnd.id);
  }
  const e2 = createEdge(model, "sequenceFlow", gw.id, excEnd.id, { name: cond, condition: `\${${slug(cond)}}`, isDefault: true });
  res.applied = true;
  res.affected = [gw.id, excEnd.id, e2.id];
  res.description = de
    ? `Ausnahmepfad nach „${anchor.name ?? anchor.id}“ für „${cond}“ ergänzt.`
    : `Added an exception path after "${anchor.name ?? anchor.id}" for "${cond}".`;
}

function replaceNode(model: BpmnModel, res: InstructionResult, text: string): void {
  const de = isGerman(text);
  const match = de
    ? afterKeyword(text, /ersetze\w* (?:die |das |den |dieses |diese )?/i, /\bdurch\b/i)
    : afterKeyword(text, /replace (?:the |this )?/i, /\bwith\b/i);
  const node = match ? findNodeByText(model, match) : undefined;
  if (!node) {
    res.description = de ? `Element zum Ersetzen nicht gefunden („${match ?? ""}“).` : `Could not find the element to replace ("${match ?? ""}").`;
    return;
  }
  const splitWord = de ? "durch" : "with";
  const newType = inferType(text.slice(text.toLowerCase().indexOf(splitWord) + splitWord.length));
  node.type = newType;
  node.bounds = { ...node.bounds, ...defaultDims(newType) };
  if (newType.endsWith("Gateway") && (!node.name || !node.name.endsWith("?"))) node.name = (node.name ?? (de ? "Entscheidung" : "Decision")) + "?";
  res.applied = true;
  res.affected = [node.id];
  res.description = de ? `„${match}“ durch ein ${newType} ersetzt.` : `Replaced "${match}" with a ${newType}.`;
}

function moveBefore(model: BpmnModel, res: InstructionResult, text: string): void {
  const de = isGerman(text);
  const m =
    text.match(/move (?:the )?(.+?) (?:before|ahead of) (?:the )?(.+)$/i) ??
    text.match(/verschieb\w* (?:die |das |den )?(.+?) (?:vor) (?:die |das |den |dem )?(.+)$/i);
  if (!m) {
    res.description = de ? "Format: Verschiebe <X> vor <Y>." : "Use: move <X> before <Y>.";
    return;
  }
  const node = findNodeByText(model, m[1]);
  const target = findNodeByText(model, m[2]);
  if (!node || !target) {
    res.description = de ? `„${m[1]}“ oder „${m[2]}“ nicht gefunden.` : `Could not find "${m[1]}" or "${m[2]}".`;
    return;
  }
  // detach node: connect its predecessors to its successors
  const incs = incomingEdges(model, node.id);
  const outs = outgoingEdges(model, node.id);
  const succ = outs[0]?.target;
  for (const e of incs) if (succ) e.target = succ;
  for (const e of outs) delete model.edges[e.id];
  // re-insert before target
  spliceBefore(model, target, node);
  res.applied = true;
  res.affected = [node.id];
  res.description = de ? `„${node.name}“ vor „${target.name}“ verschoben.` : `Moved "${node.name}" before "${target.name}".`;
}

function rename(model: BpmnModel, res: InstructionResult, text: string): void {
  const de = isGerman(text);
  const m =
    text.match(/rename (?:the )?(.+?) to ["']?(.+?)["']?$/i) ??
    text.match(/benenne (?:die |das |den )?(.+?) (?:in|zu) ["']?(.+?)["']?(?: um)?$/i);
  if (!m) {
    res.description = de ? "Format: Benenne <X> in <neuer Name> um." : "Use: rename <X> to <new name>.";
    return;
  }
  const node = findNodeByText(model, m[1]);
  if (!node) {
    res.description = de ? `„${m[1]}“ nicht gefunden.` : `Could not find "${m[1]}".`;
    return;
  }
  node.name = m[2];
  res.applied = true;
  res.affected = [node.id];
  res.description = de ? `In „${m[2]}“ umbenannt.` : `Renamed to "${m[2]}".`;
}

function splitLanes(model: BpmnModel, res: InstructionResult, names: string[]): void {
  if (names.length < 1) {
    res.description = "Geben Sie die zu erstellenden Bahnen an, z. B. „Einkauf und Bauleitung in separate Bahnen aufteilen“.";
    return;
  }
  const created: string[] = [];
  for (const name of names) {
    const exists = Object.values(model.lanes).find((l) => l.name?.toLowerCase() === name.toLowerCase());
    if (exists) continue;
    const lane = createLane(model, { name: capitalize(name), parent: model.rootProcessId });
    created.push(lane.id);
    // assign matching nodes by name keyword
    for (const n of Object.values(model.nodes)) {
      if (n.parent !== model.rootProcessId) continue;
      if (n.name && n.name.toLowerCase().includes(name.toLowerCase())) {
        n.lane = lane.id;
        pushRef(model, lane.id, n.id);
      }
    }
  }
  res.applied = created.length > 0;
  res.affected = created;
  res.description = created.length
    ? `Bahnen erstellt: ${names.map(capitalize).join(", ")}.`
    : "Diese Bahnen existieren bereits.";
}

// ---------- text parsing helpers (bilingual) ----------

function resolveAnchor(model: BpmnModel, text: string): FlowNode | undefined {
  const before = text.match(/(?:before|vor) (?:the |dem |der |den |das |shipment|sending )?(.+?)(?:\.|$)/i);
  if (before) {
    const n = findNodeByText(model, before[1]);
    if (n) return n;
  }
  const after = text.match(/(?:after|nach) (?:the |dem |der |den |das )?(.+?)(?:\.|$)/i);
  if (after) {
    const n = findNodeByText(model, after[1]);
    if (n) {
      // anchor is the successor of n
      const out = outgoingEdges(model, n.id)[0];
      return out ? model.nodes[out.target] : n;
    }
  }
  return undefined;
}

function extractRole(text: string): string | undefined {
  const m = text.match(/(?:by|durch|vom|von) (?:the |a |dem |der |den |das )?([\wäöüß ]+?)(?:\.|,|before|after|vor|nach|$)/i);
  if (m) return m[1].trim();
  return undefined;
}

function extractObject(text: string): string | undefined {
  const m =
    text.match(/approval (?:of|for) (?:the )?([\w ]+?)(?: by| before| after|\.|$)/i) ??
    text.match(/(?:freigabe|genehmigung) (?:der |des |für )?([\wäöüß ]+?)(?: durch| vor| nach|\.|$)/i);
  if (m) return m[1].trim();
  return undefined;
}

function extractActivityName(text: string): string | undefined {
  const m =
    text.match(/add (?:an? )?(?:task|step|activity|check|review|verification)\s+(?:to |for |called |named )?["']?(.+?)["']?(?: before| after| by|\.|$)/i) ??
    text.match(/(?:aufgabe|schritt|aktivität|prüfung)\s+["']?(.+?)["']?(?: vor| nach| durch| hinzu|\.|$)/i);
  if (m && m[1].trim().length > 1) return capitalize(m[1].trim());
  return undefined;
}

function extractCondition(text: string): string | undefined {
  const de = text.match(/(?:wenn|falls|für) (?:die |das |der |den |ein |eine )?(.+?)(?: ist)? (fehlt|fehlend\w*|unvollständig\w*|ungültig\w*|scheiter\w*|nicht .+)?$/i);
  if (de && (de[1] || de[2])) {
    const tail = de[2] ? `${de[1]} ${de[2]}` : de[1];
    return tail.trim().slice(0, 40);
  }
  const m = text.match(/(?:if|when|for) (?:the |an? )?(.+?)(?: is)? (missing|incomplete|invalid|fails?|not .+)?$/i);
  if (m) {
    const tail = m[2] ? `${m[1]} ${m[2]}` : m[1];
    return tail.trim().slice(0, 40);
  }
  return undefined;
}

function splitFromTo(text: string): { fromPhrase?: string; toPhrase?: string } {
  const m =
    text.match(/(?:from|after) (.+?) (?:back )?to (.+)$/i) ??
    text.match(/(?:von|nach) (.+?) (?:zurück )?(?:zu|an) (.+)$/i);
  if (m) return { fromPhrase: m[1].trim(), toPhrase: m[2].trim() };
  const f = text.match(/loop for (.+)$/i) ?? text.match(/schleife für (.+)$/i);
  return { fromPhrase: f ? f[1].trim() : undefined };
}

function extractLaneNames(text: string): string[] {
  const m =
    text.match(/split (.+?) into/i) ??
    text.match(/separate (.+?) (?:into|as)/i) ??
    text.match(/(.+?) in (?:separate )?(?:bahnen|spuren)/i);
  const src = m ? m[1] : text.replace(/.*\b(split|separate|aufteil\w*|trenn\w*)\b/i, "");
  return src
    .split(/\s*(?:,|and|und|&)\s*/i)
    .map((s) => s.replace(/\b(lanes?|into|separate|bahnen?|spuren?|aufteil\w*|trenn\w*|separate)\b/gi, "").trim())
    .filter((s) => s.length > 1);
}

function afterKeyword(text: string, start: RegExp, end: RegExp): string | undefined {
  const s = text.search(start);
  if (s < 0) return undefined;
  const rest = text.slice(s).replace(start, "");
  const e = rest.search(end);
  return (e < 0 ? rest : rest.slice(0, e)).trim();
}

function inferType(text: string): FlowElementType {
  const t = text.toLowerCase();
  if (/xor|exclusive|exklusiv/.test(t)) return "exclusiveGateway";
  if (/parallel|and gateway|und[- ]?gateway/.test(t)) return "parallelGateway";
  if (/inclusive|or gateway|inklusiv|oder[- ]?gateway/.test(t)) return "inclusiveGateway";
  if (/event.based|ereignisbasiert/.test(t)) return "eventBasedGateway";
  if (/user task|benutzeraufgabe/.test(t)) return "userTask";
  if (/service task|serviceaufgabe/.test(t)) return "serviceTask";
  if (/subprocess|sub-process|teilprozess/.test(t)) return "subProcess";
  if (/gateway/.test(t)) return "exclusiveGateway";
  return "task";
}

function defaultDims(type: FlowElementType): { width: number; height: number } {
  if (type.endsWith("Gateway")) return { width: 50, height: 50 };
  if (type === "subProcess") return { width: 350, height: 200 };
  return { width: 120, height: 80 };
}

function pushRef(model: BpmnModel, laneId: string, nodeId: string): void {
  const lane = model.lanes[laneId];
  if (lane && !lane.flowNodeRefs.includes(nodeId)) lane.flowNodeRefs.push(nodeId);
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
