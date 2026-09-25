import { BpmnModel, FlowNode, createEdge, createNode } from "../model";
import { GRAPH_EVENT_KINDS, GRAPH_NODE_TYPES, GraphEventKind, GraphIR, GraphNodeType } from "./graph-schema";
import { mapGraphToModel } from "./graph";
import type { MappingResult } from "./map";

/**
 * AI editing of an existing diagram.
 *
 * The current diagram is converted to Graph IR with its real element ids, the
 * LLM returns the complete updated IR, and `applyEditedGraph` turns it back
 * into a diagram. Everything the LLM never sees is carried over by id:
 * documentation texts, activity markers, called elements, boundary events and
 * their flows. The previous vertical arrangement is handed to the layout so
 * the diagram does not jump around after a small change.
 */

const NODE_TYPES = new Set<string>(GRAPH_NODE_TYPES);
const EVENT_KINDS = new Set<string>(GRAPH_EVENT_KINDS);

/** Current diagram (root process) → Graph IR with the diagram's own ids. */
export function modelToGraphIR(model: BpmnModel): GraphIR {
  const scope = model.rootProcessId;
  const proc = model.processes[scope];
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope && NODE_TYPES.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  const laneIds = proc?.lanes ?? [];
  const title = proc?.name || model.name || Object.values(model.participants)[0]?.name || "";
  return {
    title,
    lang: guessLang(nodes),
    lanes: laneIds.map((id) => ({ id, name: model.lanes[id]?.name ?? "" })),
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as GraphNodeType,
      name: n.name ?? "",
      lane: n.lane && laneIds.includes(n.lane) ? n.lane : "",
      event: (n.eventDefinition && EVENT_KINDS.has(n.eventDefinition) ? n.eventDefinition : "none") as GraphEventKind,
      source: n.provenance ?? "",
    })),
    flows: Object.values(model.edges)
      .filter((e) => e.type === "sequenceFlow" && ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ from: e.source, to: e.target, condition: e.name ?? "", isDefault: !!e.isDefault })),
    pools: externalPools(model).map((p) => ({ id: p.id, name: p.name ?? "" })),
    messageFlows: Object.values(model.edges)
      .filter((e) => e.type === "messageFlow")
      .filter((e) => (ids.has(e.source) && isExternal(model, e.target)) || (isExternal(model, e.source) && ids.has(e.target)))
      .map((e) => ({ from: e.source, to: e.target, name: e.name ?? "" })),
    systems: [],
    dataObjects: [],
    assumptions: [],
    ambiguities: [],
  };
}

/** Pools without a process of their own (black boxes for external parties). */
export function externalPools(model: BpmnModel) {
  return Object.values(model.participants).filter((p) => !p.processRef);
}
const isExternal = (model: BpmnModel, id: string) => !!model.participants[id] && !model.participants[id].processRef;

function guessLang(nodes: FlowNode[]): "de" | "en" {
  const text = nodes.map((n) => n.name ?? "").join(" ");
  return /[äöüß]|\b(und|prüfen|freigeben|erstellen|senden|Antrag|Rechnung)\b/i.test(text) || !/\b(the|and|check|send)\b/i.test(text) ? "de" : "en";
}

export interface GraphDiff {
  added: string[];
  removed: string[];
  changed: string[];
  flowsAdded: number;
  flowsRemoved: number;
  /** German one-line summary for the chat / preview bar. */
  summary: string;
  /** names of removed elements (they are gone from the diagram, so list them). */
  removedNames: string[];
}

/** What an edit changed, by element id. */
export function diffGraphs(before: GraphIR, after: GraphIR): GraphDiff {
  const b = new Map(before.nodes.map((n) => [n.id, n]));
  const a = new Map(after.nodes.map((n) => [n.id, n]));
  const added = [...a.keys()].filter((id) => !b.has(id));
  const removed = [...b.keys()].filter((id) => !a.has(id));
  const laneName = (ir: GraphIR, id: string) => ir.lanes.find((l) => l.id === id)?.name ?? "";
  const changed = [...a.keys()].filter((id) => {
    const x = b.get(id);
    const y = a.get(id)!;
    return x && (x.name !== y.name || x.type !== y.type || x.event !== y.event || laneName(before, x.lane) !== laneName(after, y.lane));
  });
  const key = (f: GraphIR["flows"][number]) => `${f.from}>${f.to}>${f.condition}`;
  const fb = new Set(before.flows.map(key));
  const fa = new Set(after.flows.map(key));
  const flowsAdded = [...fa].filter((k) => !fb.has(k)).length;
  const flowsRemoved = [...fb].filter((k) => !fa.has(k)).length;
  const removedNames = removed.map((id) => b.get(id)!.name || b.get(id)!.type);

  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} Element(e) hinzugefügt`);
  if (changed.length) parts.push(`${changed.length} geändert`);
  if (removed.length) parts.push(`${removed.length} entfernt (${removedNames.join(", ")})`);
  if (flowsAdded || flowsRemoved) parts.push(`${flowsAdded} Verbindung(en) neu, ${flowsRemoved} entfernt`);
  return {
    added,
    removed,
    changed,
    flowsAdded,
    flowsRemoved,
    removedNames,
    summary: parts.length ? parts.join(", ") + "." : "Keine Änderung am Diagramm.",
  };
}

/**
 * Build the edited diagram. Keeps ids, carries over what the IR does not hold,
 * and keeps the previous arrangement where possible.
 */
export function applyEditedGraph(prev: BpmnModel, ir: GraphIR, opts: { repairs?: string[]; instruction?: string } = {}): MappingResult {
  const scope = prev.rootProcessId;
  const preferOrder: Record<string, number> = {};
  for (const n of Object.values(prev.nodes)) if (n.parent === scope) preferOrder[n.id] = n.bounds.y + n.bounds.height / 2;
  const pool = Object.values(prev.participants).find((p) => p.processRef === scope);

  const result = mapGraphToModel(ir, {
    keepIds: true,
    processId: scope,
    participantName: pool?.name,
    repairs: opts.repairs,
    preferOrder,
    beforeLayout: (model) => {
      // Carry over per-element data the LLM never sees.
      for (const n of Object.values(model.nodes)) {
        const old = prev.nodes[n.id];
        if (!old) continue;
        n.documentation ??= old.documentation;
        n.markers ??= old.markers;
        n.calledElement ??= old.calledElement;
        if (old.type === n.type) n.collapsed ??= old.collapsed;
      }
      for (const e of Object.values(model.edges)) {
        const old = Object.values(prev.edges).find((o) => o.source === e.source && o.target === e.target);
        if (old) e.documentation ??= old.documentation;
      }
      // Re-attach boundary events whose host still exists, with their flows.
      for (const b of Object.values(prev.nodes)) {
        if (b.parent !== scope || b.type !== "boundaryEvent" || !b.attachedToRef || !model.nodes[b.attachedToRef]) continue;
        const host = model.nodes[b.attachedToRef];
        createNode(model, "boundaryEvent", {
          id: b.id,
          name: b.name,
          eventDefinition: b.eventDefinition,
          cancelActivity: b.cancelActivity,
          attachedToRef: host.id,
          lane: host.lane,
          documentation: b.documentation,
        });
        for (const e of Object.values(prev.edges)) {
          if (e.source === b.id && model.nodes[e.target]) {
            createEdge(model, "sequenceFlow", b.id, e.target, { id: e.id, name: e.name, condition: e.condition });
          }
        }
      }
    },
  });
  const lost = notCarriedOver(prev);
  if (lost) result.review.findings = [`${lost} – bei der KI-Änderung nicht übernommen. „Verwerfen“ stellt das vorherige Diagramm wieder her.`, ...(result.review.findings ?? [])];
  return result;
}

/** Elements outside what the AI edit can represent (so they would be dropped). */
function notCarriedOver(prev: BpmnModel): string {
  const scope = prev.rootProcessId;
  const count = (pred: (n: FlowNode) => boolean) => Object.values(prev.nodes).filter(pred).length;
  const parts: string[] = [];
  const data = count((n) => n.type === "dataObjectReference" || n.type === "dataStoreReference");
  const notes = count((n) => n.type === "textAnnotation");
  const nested = count((n) => n.parent !== scope && prev.nodes[n.parent] !== undefined);
  const otherPools = Object.values(prev.participants).filter((p) => p.processRef && p.processRef !== scope).length;
  if (data) parts.push(`${data} Datenobjekt(e)/-speicher`);
  if (notes) parts.push(`${notes} Anmerkung(en)`);
  if (nested) parts.push(`${nested} Element(e) innerhalb von Teilprozessen`);
  if (otherPools) parts.push(`${otherPools} weitere(r) Pool(s)`);
  return parts.join(", ");
}
