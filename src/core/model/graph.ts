import { BpmnModel, Edge, FlowNode } from "./types";

/**
 * Graph utilities over a BpmnModel. The layout and routing engines treat the
 * sequence-flow graph as a directed graph and need fast adjacency, topological
 * ordering and back-edge detection.
 */

export interface Adjacency {
  outgoing: Record<string, Edge[]>;
  incoming: Record<string, Edge[]>;
}

/** Build adjacency restricted to a given parent scope and edge predicate. */
export function buildAdjacency(
  model: BpmnModel,
  opts?: { scope?: string; types?: Edge["type"][] },
): Adjacency {
  const types = opts?.types ?? ["sequenceFlow"];
  const outgoing: Record<string, Edge[]> = {};
  const incoming: Record<string, Edge[]> = {};
  for (const node of Object.values(model.nodes)) {
    if (opts?.scope && node.parent !== opts.scope) continue;
    outgoing[node.id] = [];
    incoming[node.id] = [];
  }
  for (const edge of Object.values(model.edges)) {
    if (!types.includes(edge.type)) continue;
    const s = model.nodes[edge.source];
    const t = model.nodes[edge.target];
    if (!s || !t) continue;
    if (opts?.scope && (s.parent !== opts.scope || t.parent !== opts.scope)) continue;
    (outgoing[edge.source] ||= []).push(edge);
    (incoming[edge.target] ||= []).push(edge);
  }
  return { outgoing, incoming };
}

export function nodesInScope(model: BpmnModel, scope: string): FlowNode[] {
  return Object.values(model.nodes).filter((n) => n.parent === scope);
}

/** Source nodes: no incoming sequence flow within scope (start events, orphans). */
export function findRoots(adj: Adjacency): string[] {
  return Object.keys(adj.outgoing).filter((id) => (adj.incoming[id] ?? []).length === 0);
}

/**
 * Detect back edges via DFS. A back edge points to an ancestor currently on the
 * DFS stack — i.e. it closes a cycle. These are the "rework / loop" edges that
 * must be routed specially so the dominant forward reading direction survives.
 *
 * Returns the set of edge ids classified as back edges. Deterministic: nodes
 * and successors are visited in a stable (insertion) order.
 */
export function detectBackEdges(adj: Adjacency, roots?: string[]): Set<string> {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color: Record<string, number> = {};
  const backEdges = new Set<string>();
  const allNodes = Object.keys(adj.outgoing);
  for (const id of allNodes) color[id] = WHITE;

  const startSet = roots && roots.length ? roots : allNodes;
  // Iterative DFS to avoid stack overflows on large graphs.
  for (const root of startSet) {
    if (color[root] !== WHITE) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    color[root] = GRAY;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = adj.outgoing[frame.id] ?? [];
      if (frame.i >= edges.length) {
        color[frame.id] = BLACK;
        stack.pop();
        continue;
      }
      const edge = edges[frame.i++];
      const next = edge.target;
      if (color[next] === GRAY) {
        backEdges.add(edge.id);
      } else if (color[next] === WHITE) {
        color[next] = GRAY;
        stack.push({ id: next, i: 0 });
      }
    }
  }
  return backEdges;
}

/**
 * Topological-ish ordering ignoring back edges. Produces a stable order used by
 * the layered layout to assign ranks. Falls back to insertion order for the
 * unreachable remainder so disconnected fragments still get placed.
 */
export function topoOrder(adj: Adjacency, backEdges: Set<string>): string[] {
  const indeg: Record<string, number> = {};
  for (const id of Object.keys(adj.outgoing)) indeg[id] = 0;
  for (const id of Object.keys(adj.outgoing)) {
    for (const e of adj.outgoing[id]) {
      if (backEdges.has(e.id)) continue;
      indeg[e.target] = (indeg[e.target] ?? 0) + 1;
    }
  }
  const queue = Object.keys(indeg).filter((id) => indeg[id] === 0);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of adj.outgoing[id] ?? []) {
      if (backEdges.has(e.id)) continue;
      indeg[e.target] -= 1;
      if (indeg[e.target] === 0) queue.push(e.target);
    }
  }
  // Append any remaining (cycle remnants) deterministically.
  for (const id of Object.keys(adj.outgoing)) if (!seen.has(id)) order.push(id);
  return order;
}
