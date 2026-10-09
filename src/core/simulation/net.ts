import type { BpmnModel, Edge, FlowNode } from "../model";

/**
 * BPMN token semantics of one process scope, shared by the exhaustive check
 * (soundness.ts) and the automatic run-through (scenarios.ts), so both follow
 * exactly the same rules.
 *
 * A marking counts tokens per sequence flow (0, 1, 2 = "two or more").
 * The rules follow ISO/IEC 19510 (BPMN 2.0.1), clause 13:
 * - Activities and events consume one token from any incoming flow (13.3.1:
 *   several incoming flows act like an XOR merge). Outgoing flows without a
 *   condition always get a token; flows with a condition any selection; the
 *   default flow only when no condition holds.
 * - XOR / event-based gateways pass one token to exactly one outgoing flow.
 * - AND gateways wait for all incoming flows and fire all outgoing (13.4.1).
 * - OR gateways split into any non-empty selection (or the default alone) and
 *   join by table 13.3: they wait only for a token that can still reach an
 *   empty incoming flow AND cannot reach one that already holds a token.
 * - Complex gateways have an activation expression the diagram does not
 *   carry; they are treated like OR gateways, whose synchronisation they use
 *   for their reset (10.6.5).
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

/**
 * Selections of a set of flows: every subset (with or without the empty one);
 * for more than 6 flows only all, none and each single flow, to stay small.
 */
function selections(flows: Edge[], withEmpty: boolean): Edge[][] {
  const out: Edge[][] = withEmpty ? [[]] : [];
  if (!flows.length) return out;
  if (flows.length <= 6) {
    for (let mask = 1; mask < 1 << flows.length; mask++) out.push(flows.filter((_, i) => mask & (1 << i)));
  } else {
    out.push(flows, ...flows.map((e) => [e]));
  }
  return out;
}

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
  const edgeById = new Map(flows.map((f) => [f.id, f]));
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

  // OR-join (table 13.3): the incoming flows of `join` a token on `edge` can
  // still reach, along paths that do not pass through the join itself.
  const reachIns = new Map<string, Set<string>>();
  const joinInputsReached = (edge: Edge, join: string): Set<string> => {
    const key = `${edge.id}|${join}`;
    const cached = reachIns.get(key);
    if (cached) return cached;
    const reached = new Set<string>();
    const seen = new Set<string>([edge.id]);
    const stack = [edge];
    while (stack.length) {
      const e = stack.pop()!;
      if (e.target === join) {
        reached.add(e.id);
        continue;
      }
      for (const nx of outs.get(e.target) ?? []) if (!seen.has(nx.id)) (seen.add(nx.id), stack.push(nx));
      // a boundary event of the target can also pass the token on
      for (const b of boundaries.get(e.target) ?? []) for (const nx of outs.get(b.id) ?? []) if (!seen.has(nx.id)) (seen.add(nx.id), stack.push(nx));
    }
    reachIns.set(key, reached);
    return reached;
  };
  const isOrLike = (n: FlowNode) => n.type === "inclusiveGateway" || n.type === "complexGateway";

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
      if (n.type === "parallelGateway") return [all];
      const def = all.filter((e) => e.isDefault);
      if (isOrLike(n)) {
        // every flow is a choice; the default only when no other is taken
        const rest = all.filter((e) => !e.isDefault);
        return [...selections(rest, false), ...(def.length ? [def] : [])];
      }
      // Activity / event (13.3.1): flows without a condition always run, flows
      // with a condition in any selection, the default only if none of them does.
      const cond = all.filter((e) => e.condition && !e.isDefault);
      if (!cond.length && !def.length) return [all];
      const always = all.filter((e) => !e.condition && !e.isDefault);
      const result = selections(cond, true).map((sel) => [...always, ...sel, ...(sel.length ? [] : def)]);
      return result.filter((r) => r.length);
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
    if (n.type === "parallelGateway") {
      if (!inFlows.length || !inFlows.every(has)) return result;
      for (const o of outputs()) result.push({ consume: inFlows, ...o });
    } else if (isOrLike(n) && inFlows.length > 1) {
      const marked = inFlows.filter(has);
      if (!marked.length) return result;
      // Table 13.3: wait while some token can reach an empty incoming flow
      // without also being able to reach one that already holds a token.
      const markedIds = new Set(marked.map((e) => e.id));
      const waiting = [...m.entries()].some(([id, c]) => {
        if (c <= 0) return false;
        const e = edgeById.get(id);
        if (!e) return false;
        const reached = joinInputsReached(e, n.id);
        let toEmpty = false;
        let toMarked = false;
        for (const r of reached) markedIds.has(r) ? (toMarked = true) : (toEmpty = true);
        return toEmpty && !toMarked;
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
