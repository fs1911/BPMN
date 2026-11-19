import { BpmnModel, Edge, FlowNode, cloneModel, createEdge, createNode } from "../model";
import { countCrossings } from "../geometry/geometry";
import { autoLayout } from "./index";
import { measureLayout } from "./metrics";

/**
 * Crossings the layout could not avoid → a pair of link events (ISO/IEC 19510,
 * 10.5.4: "go to" within one process level). The crossing flow is cut: the
 * source ends in a throwing link event, the target is reached from a catching
 * link event of the same name. Applied flow by flow, longest first, and kept
 * only where the crossings really drop — a link makes the diagram shorter to
 * read but the flow harder to follow, so as few as possible.
 */
export interface LinkResult {
  model: BpmnModel;
  /** names of the link pairs added */
  links: string[];
  before: number;
  after: number;
}

const MAX_LINKS = 4;
const CANDIDATES_PER_ROUND = 6;

export function linkCrossings(input: BpmnModel, scope = input.rootProcessId): LinkResult | undefined {
  let best = cloneModel(input);
  autoLayout(best, scope);
  const base = measureLayout(best, scope);
  const before = base.crossings;
  // a link must not push another flow into a long detour
  const detourCap = Math.max(base.maxDetour, 700);
  if (!before) return undefined;
  let crossings = before;
  const links: string[] = [];
  const used = new Set(Object.values(input.nodes).filter((n) => n.eventDefinition === "link").map((n) => (n.name ?? "").trim()));

  for (let round = 0; round < MAX_LINKS && crossings > 0; round++) {
    const candidates = crossingFlows(best, scope).slice(0, CANDIDATES_PER_ROUND);
    let accepted = false;
    for (const e of candidates) {
      const name = nextName(used, targetName(best, e.target));
      const trial = cloneModel(best);
      cutWithLink(trial, trial.edges[e.id], name);
      autoLayout(trial, scope);
      const m = measureLayout(trial, scope);
      if (m.crossings < crossings && m.overlaps + m.shapeHits + m.outsidePool + m.nodeOverlaps === 0 && m.maxDetour <= detourCap) {
        best = trial;
        crossings = m.crossings;
        used.add(name);
        links.push(name);
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  return links.length ? { model: best, links, before, after: crossings } : undefined;
}

/** Sequence flows that cross another one, longest first (long jumps are what links are for). */
function crossingFlows(model: BpmnModel, scope: string): Edge[] {
  const seq = Object.values(model.edges).filter(
    (e) =>
      e.type === "sequenceFlow" &&
      e.waypoints &&
      model.nodes[e.source]?.parent === scope &&
      model.nodes[e.source].type !== "boundaryEvent" &&
      model.nodes[e.source].eventDefinition !== "link" &&
      model.nodes[e.target]?.eventDefinition !== "link",
  );
  const hits = new Map<string, number>();
  for (let i = 0; i < seq.length; i++)
    for (let j = i + 1; j < seq.length; j++) {
      const n = countCrossings(seq[i].waypoints!, seq[j].waypoints!);
      if (n) (hits.set(seq[i].id, (hits.get(seq[i].id) ?? 0) + n), hits.set(seq[j].id, (hits.get(seq[j].id) ?? 0) + n));
    }
  const len = (e: Edge) => e.waypoints!.slice(1).reduce((s, p, i) => s + Math.abs(p.x - e.waypoints![i].x) + Math.abs(p.y - e.waypoints![i].y), 0);
  return seq.filter((e) => hits.has(e.id)).sort((a, b) => hits.get(b.id)! - hits.get(a.id)! || len(b) - len(a));
}

/** The name a reader looks for: the target, or past unnamed joins the next named step. */
function targetName(model: BpmnModel, id: string): string | undefined {
  const seen = new Set<string>();
  let cur: FlowNode | undefined = model.nodes[id];
  while (cur && !cur.name?.trim() && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = Object.values(model.edges).find((x) => x.type === "sequenceFlow" && x.source === cur!.id);
    cur = next ? model.nodes[next.target] : undefined;
  }
  return cur?.name;
}

/** "A – Mahnstufen prüfen": a letter for the pair plus where it leads. */
function nextName(used: Set<string>, target?: string): string {
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if ([...used].some((u) => u === letter || u.startsWith(`${letter} – `))) continue;
    const t = (target ?? "").replace(/\s+/g, " ").trim();
    return t ? `${letter} – ${t.length > 28 ? t.slice(0, 27) + "…" : t}` : letter;
  }
  return `Link ${used.size + 1}`;
}

/** source → [throw link] … [catch link] → target; the flow keeps its condition at the source. */
export function cutWithLink(model: BpmnModel, e: Edge, name: string): void {
  const s = model.nodes[e.source];
  const t = model.nodes[e.target];
  const scope = s.parent;
  const thrower = createNode(model, "intermediateThrowEvent", { name, parent: scope, lane: s.lane, eventDefinition: "link" });
  const catcher = createNode(model, "intermediateCatchEvent", { name, parent: scope, lane: t.lane, eventDefinition: "link" });
  createEdge(model, "sequenceFlow", s.id, thrower.id, { name: e.name, condition: e.condition, isDefault: e.isDefault });
  createEdge(model, "sequenceFlow", catcher.id, t.id);
  delete model.edges[e.id];
}
