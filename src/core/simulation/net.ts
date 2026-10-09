import type { BpmnModel, Edge, FlowNode } from "../model";

/**
 * BPMN token semantics of one process scope, shared by the exhaustive check
 * (soundness.ts) and the automatic run-through (scenarios.ts), so both follow
 * exactly the same rules.
 *
 * A marking counts tokens per sequence flow (0, 1, 2 = "two or more").
 * Activities and events consume one token from any incoming flow and produce
 * one per outgoing flow (conditional flows: any non-empty selection); XOR /
 * event-based gateways pass one token to exactly one outgoing flow; AND
 * gateways wait for all incoming and fire all outgoing; OR gateways split into
 * any non-empty selection and join when no further token can still arrive.
 * Boundary events are alternative (interrupting) or additional
 * (non-interrupting) outcomes of their host; link events jump by name; a
 * terminate end event ends every path.
 */

export type Marking = Map<string, number>;

export interface Firing {
  consume: Edge[];
  produce: Edge[];
  /** boundary or link-catch events that fire together with the node */
  extra: string[];
}

export interface ScopeNet {
  nodes: FlowNode[];
  ins: Map<string, Edge[]>;
  outs: Map<string, Edge[]>;
  /** start events, or nodes without incoming flow if there are none */
  starts: FlowNode[];
  node(id: string): FlowNode;
  /** every way node n can fire in marking m (empty: not enabled) */
  firings(n: FlowNode, m: Marking): Firing[];
  /** the marking after a firing; overflow = a flow that now holds two tokens */
  apply(n: FlowNode, m: Marking, f: Firing): { marking: Marking; overflow?: Edge };
}

export const NON_FLOW = new Set(["dataObjectReference", "dataStoreReference", "textAnnotation"]);
export const XOR_LIKE = new Set(["exclusiveGateway", "eventBasedGateway"]);

export function buildNet(model: BpmnModel, scope: string): ScopeNet | undefined {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope && !NON_FLOW.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  const flows = Object.values(model.edges).filter((e) => e.type === "sequenceFlow" && ids.has(e.source) && ids.has(e.target));
  if (!nodes.length || !flows.length) return undefined;
  const ins = new Map<string, Edge[]>(nodes.map((n) => [n.id, []]));
  const outs = new Map<string, Edge[]>(nodes.map((n) => [n.id, []]));
  for (const f of flows) {
    outs.get(f.source)!.push(f);
    ins.get(f.target)!.push(f);
  }
  const node = (id: string) => model.nodes[id];
  const group = (list: FlowNode[], key: (n: FlowNode) => string | undefined) => {
    const m = new Map<string, FlowNode[]>();
    for (const n of list) {
      const k = key(n);
      if (k !== undefined) (m.get(k) ?? m.set(k, []).get(k)!).push(n);
    }
    return m;
  };
  const boundaries = group(nodes, (n) => (n.type === "boundaryEvent" ? n.attachedToRef : undefined));
  const linkTargets = group(nodes, (n) => (n.type === "intermediateCatchEvent" && n.eventDefinition === "link" ? n.name ?? "" : undefined));

  // OR-join: which flows can still deliver a token to incoming flow i (not passing through the join).
  const upstream = new Map<string, Set<string>>();
  const canReach = (edge: Edge, join: string): Set<string> => {
    const key = `${edge.id}|${join}`;
    if (upstream.has(key)) return upstream.get(key)!;
    const seen = new Set<string>([edge.id]);
    const stack = [edge];
    while (stack.length) {
      const e = stack.pop()!;
      if (e.source === join) continue;
      for (const p of ins.get(e.source) ?? []) if (!seen.has(p.id)) (seen.add(p.id), stack.push(p));
    }
    upstream.set(key, seen);
    return seen;
  };

  let starts = nodes.filter((n) => n.type === "startEvent");
  if (!starts.length) {
    starts = nodes.filter((n) => !ins.get(n.id)!.length && n.type !== "boundaryEvent" && !(n.type === "intermediateCatchEvent" && n.eventDefinition === "link"));
  }

  const firings = (n: FlowNode, m: Marking): Firing[] => {
    const inFlows = ins.get(n.id)!;
    const outFlows = outs.get(n.id)!;
    const has = (e: Edge) => (m.get(e.id) ?? 0) > 0;
    // Selections of outgoing flows for a split.
    const choices = (all: Edge[]): Edge[][] => {
      if (XOR_LIKE.has(n.type)) return all.map((e) => [e]);
      const conditional = all.some((e) => e.condition || e.isDefault) || n.type === "inclusiveGateway";
      if (n.type === "parallelGateway" || !conditional || n.type === "complexGateway") return [all];
      const def = all.filter((e) => e.isDefault);
      const rest = all.filter((e) => !e.isDefault);
      const subsets: Edge[][] = [];
      if (rest.length <= 6) {
        for (let mask = 1; mask < 1 << rest.length; mask++) subsets.push(rest.filter((_, i) => mask & (1 << i)));
      } else {
        subsets.push(rest, ...rest.map((e) => [e]));
      }
      if (def.length) subsets.push(def);
      return subsets;
    };
    const outputs = (): { produce: Edge[]; extra: string[] }[] => {
      if (n.type === "endEvent") return [{ produce: [], extra: [] }];
      if (n.type === "intermediateThrowEvent" && n.eventDefinition === "link") {
        const targets = (linkTargets.get(n.name ?? "") ?? []).flatMap((t) => outs.get(t.id)!.map((e) => ({ e, t: t.id })));
        return [{ produce: targets.map((x) => x.e), extra: targets.map((x) => x.t) }];
      }
      const base = outFlows.length ? choices(outFlows).map((p) => ({ produce: p, extra: [] as string[] })) : [{ produce: [], extra: [] }];
      const alt: { produce: Edge[]; extra: string[] }[] = [];
      for (const b of boundaries.get(n.id) ?? []) {
        const bOut = outs.get(b.id)!;
        if (b.cancelActivity === false) for (const p of base) alt.push({ produce: [...p.produce, ...bOut], extra: [b.id] });
        else alt.push({ produce: bOut, extra: [b.id] });
      }
      return [...base, ...alt];
    };

    const result: Firing[] = [];
    if (n.type === "parallelGateway" || n.type === "complexGateway") {
      if (!inFlows.length || !inFlows.every(has)) return result;
      for (const o of outputs()) result.push({ consume: inFlows, ...o });
    } else if (n.type === "inclusiveGateway" && inFlows.length > 1) {
      const marked = inFlows.filter(has);
      if (!marked.length) return result;
      const waiting = inFlows
        .filter((i) => !has(i))
        .some((i) => {
          const up = canReach(i, n.id);
          return [...m.entries()].some(([e, c]) => c > 0 && up.has(e));
        });
      if (waiting) return result;
      for (const o of outputs()) result.push({ consume: marked, ...o });
    } else {
      // activities, events, XOR / event-based gateways: one token from any incoming flow
      for (const i of inFlows.filter(has)) for (const o of outputs()) result.push({ consume: [i], ...o });
    }
    return result;
  };

  const apply = (n: FlowNode, m: Marking, f: Firing) => {
    const next = new Map(m);
    for (const e of f.consume) next.set(e.id, (next.get(e.id) ?? 0) - 1);
    if (n.type === "endEvent" && n.eventDefinition === "terminate") next.clear();
    let overflow: Edge | undefined;
    for (const e of f.produce) {
      const c = next.get(e.id) ?? 0;
      if (c >= 1) overflow = e;
      next.set(e.id, Math.min(2, c + 1));
    }
    for (const [k, c] of next) if (c <= 0) next.delete(k);
    return { marking: next, overflow };
  };

  return { nodes, ins, outs, starts, node, firings, apply };
}
