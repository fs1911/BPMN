import { BpmnModel, FlowNode, isActivity } from "../model";

/**
 * Systems and data next to the step that uses them: data stores (Abacus,
 * DocuWare, …) and data objects linked to an activity by an association sit
 * directly below it, the link as a short vertical line.
 *
 * The layered layout knows nothing about them, so the room is reserved by
 * making each such activity taller during layout (symmetrically: flows keep
 * meeting its middle) and handing the room back afterwards.
 */

export const STORE_SIZE = { width: 44, height: 40 };
const GAP = 12;
/** symbol + gap + its name below */
const ROW = GAP + STORE_SIZE.height + 22;
const PER_ROW = 2;

export const isArtifactNode = (n: FlowNode | undefined) => n?.type === "dataStoreReference" || n?.type === "dataObjectReference";

/** activity id → its data stores / objects (in a stable order) */
export function artifactLinks(model: BpmnModel, scope: string): Map<string, string[]> {
  const links = new Map<string, string[]>();
  for (const e of Object.values(model.edges)) {
    if (e.type !== "association") continue;
    const [act, art] = isArtifactNode(model.nodes[e.target]) ? [e.source, e.target] : [e.target, e.source];
    const a = model.nodes[act];
    if (!a || a.parent !== scope || !isActivity(a.type) || !isArtifactNode(model.nodes[art])) continue;
    const list = links.get(act) ?? links.set(act, []).get(act)!;
    if (!list.includes(art)) list.push(art);
  }
  for (const list of links.values()) list.sort();
  return links;
}

const reserve = (count: number) => Math.ceil(count / PER_ROW) * ROW;

/** Make room: activities with artifacts grow by the room below (and the same above). */
export function reserveArtifactSpace(model: BpmnModel, links: Map<string, string[]>): void {
  for (const [id, arts] of links) {
    const b = model.nodes[id].bounds;
    const r = reserve(arts.length);
    b.y -= r;
    b.height += 2 * r;
  }
}

/** Give the room back and put the artifacts into it, then draw the links. */
export function placeArtifacts(model: BpmnModel, links: Map<string, string[]>): void {
  for (const [id, arts] of links) {
    const b = model.nodes[id].bounds;
    const r = reserve(arts.length);
    b.y += r;
    b.height -= 2 * r;
    const cx = b.x + b.width / 2;
    arts.forEach((artId, i) => {
      const n = model.nodes[artId];
      const row = Math.floor(i / PER_ROW);
      const inRow = Math.min(PER_ROW, arts.length - row * PER_ROW);
      const col = i % PER_ROW;
      const spacing = 70;
      const x = cx + (col - (inRow - 1) / 2) * spacing;
      n.bounds = { x: Math.round(x - STORE_SIZE.width / 2), y: Math.round(b.y + b.height + GAP + row * ROW), width: STORE_SIZE.width, height: STORE_SIZE.height };
    });
  }
  routeArtifactLinks(model);
}

/** Straight link between an activity and its artifact, between the facing sides. */
export function routeArtifactLinks(model: BpmnModel): void {
  for (const e of Object.values(model.edges)) {
    if (e.type !== "association") continue;
    const s = model.nodes[e.source];
    const t = model.nodes[e.target];
    if (!s || !t || !(isArtifactNode(s) || isArtifactNode(t))) continue;
    const a = s.bounds;
    const c = t.bounds;
    const overlapX = Math.min(a.x + a.width, c.x + c.width) - Math.max(a.x, c.x);
    if (overlapX > 4) {
      // stacked: vertical line in the shared column
      const x = Math.round(Math.max(a.x, c.x) + overlapX / 2);
      const down = a.y + a.height <= c.y;
      e.waypoints = down
        ? [{ x, y: a.y + a.height }, { x, y: c.y }]
        : [{ x, y: a.y }, { x, y: c.y + c.height }];
    } else {
      const right = a.x + a.width <= c.x;
      const y1 = Math.round(a.y + a.height / 2);
      const y2 = Math.round(c.y + c.height / 2);
      e.waypoints = right
        ? [{ x: a.x + a.width, y: y1 }, { x: c.x, y: y2 }]
        : [{ x: a.x, y: y1 }, { x: c.x + c.width, y: y2 }];
    }
  }
}
