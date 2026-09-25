import { autoLayout } from "../layout";
import {
  BpmnModel,
  EventDefinitionType,
  createEdge,
  createLane,
  createNode,
  createParticipant,
  emptyModel,
} from "../model";
import { assessModel } from "./quality";
import { MappingResult, removeEmptyLanes } from "./map";
import { Ambiguity, ReviewReport } from "./types";
import {
  GRAPH_EVENT_KINDS,
  GRAPH_NODE_TYPES,
  GraphEventKind,
  GraphFlowIR,
  GraphIR,
  GraphNodeIR,
  GraphNodeType,
} from "./graph-schema";

export * from "./graph-schema";

// ---------------------------------------------------------------------------
// Sanitizing

export interface SanitizeResult {
  ir: GraphIR;
  /** human-readable list of repairs applied (German, shown in the review). */
  repairs: string[];
}

const NODE_TYPE_SET = new Set<string>(GRAPH_NODE_TYPES);
const EVENT_SET = new Set<string>(GRAPH_EVENT_KINDS);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/**
 * Make an untrusted graph (LLM output) referentially sound: unique ids, known
 * types, flows only between existing nodes, at least one start and one end,
 * and no dangling paths. Every repair is recorded so it can be surfaced rather
 * than silently hidden.
 */
export function sanitizeGraphIR(raw: unknown): SanitizeResult {
  const repairs: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const lanes: GraphIR["lanes"] = [];
  const laneIds = new Set<string>();
  for (const l of Array.isArray(r.lanes) ? r.lanes : []) {
    const id = str((l as any)?.id);
    const name = str((l as any)?.name);
    if (!id || !name || laneIds.has(id)) continue;
    laneIds.add(id);
    lanes.push({ id, name });
  }

  const nodes: GraphNodeIR[] = [];
  const nodeIds = new Set<string>();
  for (const n of Array.isArray(r.nodes) ? r.nodes : []) {
    const o = (n ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    if (!id || nodeIds.has(id)) {
      repairs.push(`Knoten mit fehlender/doppelter ID „${id}“ verworfen.`);
      continue;
    }
    let type = str(o.type);
    if (!NODE_TYPE_SET.has(type)) {
      repairs.push(`Unbekannter Elementtyp „${type}“ bei „${str(o.name) || id}“ als Aufgabe modelliert.`);
      type = "task";
    }
    const lane = laneIds.has(str(o.lane)) ? str(o.lane) : "";
    const event = EVENT_SET.has(str(o.event)) ? (str(o.event) as GraphEventKind) : "none";
    nodeIds.add(id);
    nodes.push({ id, type: type as GraphNodeType, name: str(o.name), lane, event, source: str(o.source) });
  }

  const flows: GraphFlowIR[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(r.flows) ? r.flows : []) {
    const o = (f ?? {}) as Record<string, unknown>;
    const from = str(o.from);
    const to = str(o.to);
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      repairs.push(`Fluss ${from || "?"} → ${to || "?"} verweist auf ein unbekanntes Element und wurde entfernt.`);
      continue;
    }
    if (from === to || seen.has(`${from}>${to}`)) continue;
    seen.add(`${from}>${to}`);
    flows.push({ from, to, condition: str(o.condition), isDefault: o.isDefault === true });
  }

  const lang: GraphIR["lang"] = r.lang === "en" ? "en" : "de";
  const de = lang === "de";
  let counter = 0;
  const freshId = (p: string) => {
    let id: string;
    do id = `${p}_fix${++counter}`;
    while (nodeIds.has(id));
    nodeIds.add(id);
    return id;
  };

  const incoming = (id: string) => flows.some((f) => f.to === id);
  const outgoing = (id: string) => flows.some((f) => f.from === id);

  // Start: if none, attach one to every node without an incoming flow.
  if (!nodes.some((n) => n.type === "startEvent") && nodes.length) {
    const roots = nodes.filter((n) => !incoming(n.id));
    const id = freshId("start");
    nodes.unshift({ id, type: "startEvent", name: de ? "Start" : "Start", lane: "", event: "none", source: "" });
    for (const t of roots.length ? roots : [nodes[1]]) flows.push({ from: id, to: t.id, condition: "", isDefault: false });
    repairs.push("Kein Startereignis vorhanden – eines wurde ergänzt.");
  }

  // Dangling paths: every non-end node needs an outgoing flow.
  const dangling = nodes.filter((n) => n.type !== "endEvent" && !outgoing(n.id));
  if (dangling.length) {
    const id = freshId("end");
    nodes.push({ id, type: "endEvent", name: de ? "Ende" : "End", lane: "", event: "none", source: "" });
    for (const d of dangling) flows.push({ from: d.id, to: id, condition: "", isDefault: false });
    repairs.push(
      `${dangling.length} Pfad(e) ohne Abschluss (${dangling.map((d) => `„${d.name || d.id}“`).join(", ")}) an ein ergänztes Endereignis angeschlossen.`,
    );
  }

  return {
    ir: {
      title: str(r.title),
      lang,
      lanes,
      nodes,
      flows,
      systems: strArr(r.systems),
      dataObjects: strArr(r.dataObjects),
      assumptions: strArr(r.assumptions),
      ambiguities: (Array.isArray(r.ambiguities) ? r.ambiguities : [])
        .map((a: any) => ({ about: str(a?.about), question: str(a?.question), options: strArr(a?.options) }))
        .filter((a) => a.question),
    },
    repairs,
  };
}

// ---------------------------------------------------------------------------
// Mapping

const EVENT_TYPES = new Set<GraphNodeType>(["startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent"]);

/** Map a sanitized GraphIR to a laid-out BpmnModel plus a review report. */
export function mapGraphToModel(ir: GraphIR, opts: { sourceText?: string; repairs?: string[] } = {}): MappingResult {
  const model: BpmnModel = emptyModel({ processId: "Process_ai", name: ir.title || undefined });
  const provenance: Record<string, string> = {};

  const laneMap: Record<string, string> = {};
  if (ir.lanes.length) {
    createParticipant(model, { name: ir.title || (ir.lang === "de" ? "Prozess" : "Process"), processRef: model.rootProcessId });
    for (const l of ir.lanes) laneMap[l.id] = createLane(model, { name: l.name, parent: model.rootProcessId }).id;
  }

  const idMap: Record<string, string> = {};
  for (const n of ir.nodes) {
    const eventDefinition: EventDefinitionType | undefined =
      EVENT_TYPES.has(n.type) && n.event !== "none" ? n.event : undefined;
    const node = createNode(model, n.type, {
      name: n.name || undefined,
      eventDefinition,
      lane: laneMap[n.lane],
      provenance: n.source || undefined,
    });
    idMap[n.id] = node.id;
    if (n.source) provenance[node.id] = n.source;
  }

  const outCount: Record<string, number> = {};
  for (const f of ir.flows) outCount[f.from] = (outCount[f.from] ?? 0) + 1;
  const typeOf = Object.fromEntries(ir.nodes.map((n) => [n.id, n.type]));

  for (const f of ir.flows) {
    const conditional =
      f.condition &&
      !f.isDefault &&
      (typeOf[f.from] === "exclusiveGateway" || typeOf[f.from] === "inclusiveGateway") &&
      outCount[f.from] > 1;
    const e = createEdge(model, "sequenceFlow", idMap[f.from], idMap[f.to], {
      name: f.condition || undefined,
      condition: conditional ? `\${${slug(f.condition)}}` : undefined,
      isDefault: f.isDefault || undefined,
    });
    if (f.condition) provenance[e.id] = `Bedingung: ${f.condition}`;
  }

  if (ir.lanes.length) {
    fillMissingLanes(model);
    removeEmptyLanes(model);
  }

  autoLayout(model, model.rootProcessId);

  const assessment = assessModel(model, { sourceText: opts.sourceText, ambiguities: ir.ambiguities.length });
  const decisions = ir.nodes
    .filter((n) => n.type.endsWith("Gateway") && n.name && (outCount[n.id] ?? 0) > 1)
    .map((n) => n.name);
  const loops = Object.values(model.edges)
    .filter((e) => e.isBackEdge)
    .map((e) => `${model.nodes[e.source]?.name || "Verzweigung"} → ${model.nodes[e.target]?.name || "?"}`);

  const review: ReviewReport = {
    roles: Object.values(model.lanes).map((l) => l.name ?? ""),
    systems: ir.systems,
    dataObjects: ir.dataObjects,
    decisions,
    loops,
    exceptions: ir.nodes.filter((n) => n.event === "error").map((n) => n.name),
    approvals: ir.nodes.filter((n) => /freigab|freigeb|genehmig|approv/i.test(n.name) && !n.type.endsWith("Gateway")).map((n) => n.name),
    checks: ir.nodes.filter((n) => /prüf|kontroll|check|verif|review/i.test(n.name) && !n.type.endsWith("Gateway")).map((n) => n.name),
    assumptions: ir.assumptions,
    ambiguities: ir.ambiguities.map<Ambiguity>((a) => ({ about: a.about, question: a.question, options: a.options.length ? a.options : undefined })),
    provenance,
    confidence: assessment.confidence,
    findings: [...(opts.repairs ?? []), ...assessment.findings],
    source: "llm",
  };
  // Repairs mean the model's own output was broken — they count against confidence too.
  review.confidence = Math.max(0.1, review.confidence - 0.08 * (opts.repairs?.length ?? 0));

  return { model, review };
}

/** Nodes the LLM left without a lane take the lane of their flow neighbour
 * (predecessor preferred), iterated to a fixpoint. */
function fillMissingLanes(model: BpmnModel): void {
  const seq = Object.values(model.edges).filter((e) => e.type === "sequenceFlow");
  const assign = (nodeId: string, laneId: string) => {
    model.nodes[nodeId].lane = laneId;
    model.lanes[laneId].flowNodeRefs.push(nodeId);
  };
  for (let pass = 0; pass <= Object.keys(model.nodes).length; pass++) {
    let changed = false;
    for (const node of Object.values(model.nodes)) {
      if (node.lane) continue;
      const lane =
        seq.filter((e) => e.target === node.id).map((e) => model.nodes[e.source]?.lane).find(Boolean) ??
        seq.filter((e) => e.source === node.id).map((e) => model.nodes[e.target]?.lane).find(Boolean);
      if (lane) {
        assign(node.id, lane);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Isolated leftovers go to the first lane so every node sits inside the pool.
  const first = Object.keys(model.lanes)[0];
  for (const node of Object.values(model.nodes)) if (!node.lane && first) assign(node.id, first);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "bedingung"
  );
}
