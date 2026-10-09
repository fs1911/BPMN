import type { BpmnModel, Edge, FlowNode } from "../model";

/**
 * Behavioural check of a process ("does it actually run?"), complementing the
 * structural validator: tokens are played through the process exactly as BPMN
 * defines it, and every reachable state is explored — not just one example
 * run, so a problem on any path is found.
 *
 * Detects
 *  - deadlock: the process gets stuck, typically an AND-join waiting for a
 *    branch that an XOR decision never sends;
 *  - lack of synchronisation: two tokens on one path, typically an AND-split
 *    merged by an XOR-join — everything after it runs twice;
 *  - no way out: a loop the process can never leave;
 *  - dead elements: never reached in any run.
 *
 * Token semantics (BPMN 2.0): activities and events consume one token from any
 * incoming flow and produce one per outgoing flow (conditional flows: any
 * non-empty selection); XOR / event-based gateways pass one token to exactly
 * one outgoing flow; AND gateways wait for all incoming and fire all outgoing;
 * OR gateways split into any non-empty selection and join when no further
 * token can still arrive. Boundary events are alternative (interrupting) or
 * additional (non-interrupting) outcomes of their host. A terminate end event
 * ends everything. Subprocess contents are checked as their own scope; message
 * flows to other pools are assumed to be answered.
 */

export type FlowIssueKind = "deadlock" | "unsafe" | "no-way-out" | "dead" | "incomplete";

export interface FlowIssue {
  kind: FlowIssueKind;
  severity: "error" | "warning" | "info";
  message: string;
  hint: string;
  /** elements to highlight; the first one is the main location */
  elementIds: string[];
  /** an example run leading there (element names) */
  trace: string[];
}

export interface SoundnessResult {
  issues: FlowIssue[];
  /** number of process states explored */
  states: number;
  /** stopped at the state or time limit — absence of issues is then not proven */
  truncated: boolean;
}

const NON_FLOW = new Set(["dataObjectReference", "dataStoreReference", "textAnnotation"]);
const XOR_LIKE = new Set(["exclusiveGateway", "eventBasedGateway"]);

interface Options {
  maxStates?: number;
  maxMs?: number;
}

export function analyzeSoundness(model: BpmnModel, opts: Options = {}): SoundnessResult {
  const maxStates = opts.maxStates ?? 20000;
  const deadline = Date.now() + (opts.maxMs ?? 300);
  const scopes = new Set<string>(Object.keys(model.processes));
  for (const n of Object.values(model.nodes)) if (n.type === "subProcess" && !n.collapsed) scopes.add(n.id);

  const issues: FlowIssue[] = [];
  let states = 0;
  let truncated = false;
  for (const scope of scopes) {
    const r = analyzeScope(model, scope, maxStates - states, deadline);
    issues.push(...r.issues);
    states += r.states;
    truncated ||= r.truncated;
    if (states >= maxStates) {
      truncated = true;
      break;
    }
  }
  return { issues, states, truncated };
}

// ---------------------------------------------------------------------------

type Marking = Map<string, number>; // sequence-flow id → tokens (0, 1, 2 = "two or more")

interface State {
  key: string;
  marking: Marking;
  parent?: number;
  via?: string; // node fired to get here
  succ: number[];
}

function analyzeScope(model: BpmnModel, scope: string, budget: number, deadline: number): SoundnessResult {
  const nodes = Object.values(model.nodes).filter((n) => n.parent === scope && !NON_FLOW.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  const flows = Object.values(model.edges).filter((e) => e.type === "sequenceFlow" && ids.has(e.source) && ids.has(e.target));
  if (!nodes.length || !flows.length) return { issues: [], states: 0, truncated: false };
  const ins = new Map<string, Edge[]>(nodes.map((n) => [n.id, []]));
  const outs = new Map<string, Edge[]>(nodes.map((n) => [n.id, []]));
  for (const f of flows) {
    outs.get(f.source)!.push(f);
    ins.get(f.target)!.push(f);
  }
  const node = (id: string) => model.nodes[id];
  const label = (id: string) => {
    const n = node(id);
    return n?.name?.trim() ? `„${n.name.trim().replace(/\s+/g, " ")}“` : TYPE_LABEL[n?.type ?? ""] ?? id;
  };
  /** Name for lists (nominative): "„Antrag prüfen“" or "Paralleles Gateway". */
  const name = (id: string) => {
    const n = node(id);
    return n?.name?.trim() ? `„${n.name.trim().replace(/\s+/g, " ")}“` : TYPE_NAME[n?.type ?? ""] ?? id;
  };
  const boundaries = new Map<string, FlowNode[]>();
  for (const n of nodes) if (n.type === "boundaryEvent" && n.attachedToRef) (boundaries.get(n.attachedToRef) ?? boundaries.set(n.attachedToRef, []).get(n.attachedToRef)!).push(n);
  const linkTargets = new Map<string, FlowNode[]>();
  for (const n of nodes) {
    if (n.type === "intermediateCatchEvent" && n.eventDefinition === "link") (linkTargets.get(n.name ?? "") ?? linkTargets.set(n.name ?? "", []).get(n.name ?? "")!).push(n);
  }

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

  // Starts: start events; without any, nodes without incoming flow.
  let starts = nodes.filter((n) => n.type === "startEvent");
  if (!starts.length) starts = nodes.filter((n) => !ins.get(n.id)!.length && n.type !== "boundaryEvent" && !(n.type === "intermediateCatchEvent" && n.eventDefinition === "link"));

  const fired = new Set<string>();
  const issues = new Map<string, FlowIssue>(); // dedupe by kind+location
  const statesOut: State[] = [];
  let truncated = false;
  const keyOf = (m: Marking) =>
    [...m.entries()]
      .filter(([, c]) => c > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([e, c]) => `${e}:${c}`)
      .join(",");
  const traceIds = (idx: number): string[] => {
    const out: string[] = [];
    for (let i: number | undefined = idx; i !== undefined; i = statesOut[i].parent) if (statesOut[i].via) out.push(statesOut[i].via!);
    return out.reverse();
  };
  const report = (key: string, issue: Omit<FlowIssue, "trace">, stateIdx: number) => {
    if (!issues.has(key)) issues.set(key, { ...issue, message: issue.message.replace(/\bbei dem\b/g, "beim"), trace: traceIds(stateIdx).map(name) });
  };

  /** All successor markings when node n fires in marking m. */
  const fire = (n: FlowNode, m: Marking): { marking: Marking; overflow?: Edge; fired: string[] }[] => {
    const inFlows = ins.get(n.id)!;
    const outFlows = outs.get(n.id)!;
    const has = (e: Edge) => (m.get(e.id) ?? 0) > 0;
    const results: { marking: Marking; overflow?: Edge; fired: string[] }[] = [];
    const emit = (consume: Edge[], produce: Edge[], extraFired: string[] = []) => {
      const next = new Map(m);
      for (const e of consume) next.set(e.id, (next.get(e.id) ?? 0) - 1);
      let overflow: Edge | undefined;
      // A terminate end event ends every running path.
      if (n.type === "endEvent" && n.eventDefinition === "terminate") next.clear();
      for (const e of produce) {
        const c = next.get(e.id) ?? 0;
        if (c >= 1) overflow = e;
        next.set(e.id, Math.min(2, c + 1));
      }
      results.push({ marking: next, overflow, fired: [n.id, ...extraFired] });
    };
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

    if (n.type === "parallelGateway" || n.type === "complexGateway") {
      if (!inFlows.length || !inFlows.every(has)) return results;
      for (const o of outputs()) emit(inFlows, o.produce, o.extra);
    } else if (n.type === "inclusiveGateway" && inFlows.length > 1) {
      const marked = inFlows.filter(has);
      if (!marked.length) return results;
      const waiting = inFlows.filter((i) => !has(i)).some((i) => {
        const up = canReach(i, n.id);
        return [...m.entries()].some(([e, c]) => c > 0 && up.has(e));
      });
      if (waiting) return results;
      for (const o of outputs()) emit(marked, o.produce, o.extra);
    } else {
      // activities, events, XOR / event-based gateways: one token from any incoming flow
      for (const i of inFlows.filter(has)) for (const o of outputs()) emit([i], o.produce, o.extra);
    }
    return results;
  };

  const explore = (start: FlowNode) => {
    const index = new Map<string, number>();
    const initial: Marking = new Map();
    for (const e of outs.get(start.id)!) initial.set(e.id, 1);
    fired.add(start.id);
    const add = (marking: Marking, parent?: number, via?: string): { idx: number; isNew: boolean } => {
      const key = keyOf(marking);
      const known = index.get(key);
      if (known !== undefined) return { idx: known, isNew: false };
      const idx = statesOut.push({ key, marking, parent, via, succ: [] }) - 1;
      index.set(key, idx);
      return { idx, isNew: true };
    };
    const first = add(initial, undefined, start.id).idx;
    const queue = [first];
    const deadStates: number[] = [];
    const begin = first;
    while (queue.length) {
      if (statesOut.length - begin >= budget || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const idx = queue.shift()!;
      const st = statesOut[idx];
      if (!st.key) continue; // empty marking: the run completed
      let any = false;
      for (const n of nodes) {
        if (n.type !== "parallelGateway" && n.type !== "inclusiveGateway" && n.type !== "complexGateway") {
          const marked = ins.get(n.id)!.filter((e) => (st.marking.get(e.id) ?? 0) > 0);
          if (marked.length >= 2) reportUnsafe(n.id, marked[0].id, idx);
        }
        for (const r of fire(n, st.marking)) {
          any = true;
          for (const f of r.fired) fired.add(f);
          if (r.overflow) reportUnsafe(r.overflow.target, r.overflow.id, idx);
          const next = add(r.marking, idx, n.id);
          st.succ.push(next.idx);
          if (next.isNew) queue.push(next.idx);
        }
      }
      if (!any) {
        deadStates.push(idx);
        reportDeadlock(idx);
      }
    }
    if (!truncated) reportNoWayOut(first, deadStates);
  };

  const reportUnsafe = (target: string, flow: string, idx: number) =>
    report(
      `unsafe|${target}`,
      {
        kind: "unsafe",
        severity: "error",
        message: `Doppelter Durchlauf bei ${label(target)}: Hier kommen zwei Pfade gleichzeitig an, aber nur einer wird erwartet – alles danach läuft zweimal ab.`,
        hint: "Parallele Pfade (nach einem UND-Gateway) mit einem parallelen Gateway (UND) zusammenführen, nicht mit einem XOR-Gateway oder direkt in eine Aufgabe. Rücksprünge aus einem parallelen Abschnitt nicht vor dessen Aufteilung führen.",
        elementIds: [target, flow],
      },
      idx,
    );

  const reportDeadlock = (idx: number) => {
    const m = statesOut[idx].marking;
    const stuck = new Set<string>();
    for (const [e, c] of m) if (c > 0) stuck.add(model.edges[e].target);
    for (const t of stuck) {
      const n = node(t);
      const missing = ins.get(t)!.filter((i) => !(m.get(i.id) ?? 0));
      const isJoin = n.type === "parallelGateway" || n.type === "inclusiveGateway" || n.type === "complexGateway";
      // Typical cause 1: a parallel path ended early at an end event (the run's trace shows it).
      const path = traceIds(idx);
      const endAt = path.findIndex((id) => node(id).type === "endEvent");
      if (isJoin && endAt >= 0) {
        const end = path[endAt];
        const decision = path.slice(0, endAt).reverse().find((id) => XOR_LIKE.has(node(id).type));
        report(
          `deadlock|${t}`,
          {
            kind: "deadlock",
            severity: "error",
            message: `Der Ablauf bleibt bei ${label(t)} stehen: Das Gateway wartet auf alle parallelen Pfade, aber einer endet vorher bei ${label(end)}${decision ? ` (nach ${label(decision)})` : ""}. Der Prozess wird so nie abgeschlossen.`,
            hint: `${label(end)} als Terminierungs-Endereignis kennzeichnen (beendet auch die parallel laufenden Pfade) oder diesen Pfad nicht enden lassen, sondern zum Zusammenführen führen.`,
            elementIds: [t, end, ...(decision ? [decision] : [])],
          },
          idx,
        );
        continue;
      }
      // Typical cause 2: an XOR decision joined by an AND gateway.
      const cause = findDecisionUpstream(missing);
      report(
        `deadlock|${t}`,
        {
          kind: "deadlock",
          severity: "error",
          message: isJoin
            ? `Der Ablauf bleibt bei ${label(t)} stehen: Das Gateway wartet auf alle eingehenden Pfade, aber ${cause ? `nach der Entscheidung ${label(cause)} kommt nur einer davon an` : "nicht alle kommen je an"}.`
            : `Der Ablauf bleibt vor ${label(t)} stehen und kommt nicht weiter.`,
          hint: isJoin
            ? "Pfade, die aus einer Entscheidung (XOR-Gateway) kommen, mit einem XOR-Gateway zusammenführen. Ein paralleles Gateway (UND) nur dort zum Zusammenführen verwenden, wo vorher parallel aufgeteilt wurde."
            : "Prüfen, ob dieses Element eine fehlende Bedingung oder einen fehlenden Ausgang hat.",
          elementIds: [t, ...(cause ? [cause] : [])],
        },
        idx,
      );
    }
  };

  /** Nearest XOR / event-based gateway upstream of the given flows. */
  const findDecisionUpstream = (missing: Edge[]): string | undefined => {
    const seen = new Set<string>();
    const queue = missing.map((e) => e.source);
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (XOR_LIKE.has(node(id).type) && outs.get(id)!.length > 1) return id;
      for (const e of ins.get(id) ?? []) queue.push(e.source);
    }
    return undefined;
  };

  /** States from which neither the end nor a (reported) deadlock is reachable: a loop with no exit. */
  const reportNoWayOut = (first: number, deadStates: number[]) => {
    const good = new Set<number>(deadStates);
    for (let i = first; i < statesOut.length; i++) if (!statesOut[i].key) good.add(i);
    const preds = new Map<number, number[]>();
    for (let i = first; i < statesOut.length; i++) for (const s of statesOut[i].succ) (preds.get(s) ?? preds.set(s, []).get(s)!).push(i);
    const stack = [...good];
    while (stack.length) {
      const s = stack.pop()!;
      for (const p of preds.get(s) ?? []) if (!good.has(p)) (good.add(p), stack.push(p));
    }
    const trapped: number[] = [];
    for (let i = first; i < statesOut.length; i++) if (!good.has(i)) trapped.push(i);
    if (!trapped.length) return;
    const loopNodes = new Set<string>();
    for (const i of trapped) for (const s of statesOut[i].succ) if (!good.has(s) && statesOut[s].via) loopNodes.add(statesOut[s].via!);
    const ids = [...loopNodes];
    const where = ids.filter((id) => node(id).type !== "startEvent");
    report(
      `no-way-out|${where.sort().join(",")}`,
      {
        kind: "no-way-out",
        severity: "error",
        message: `Endlosschleife: Aus dem Bereich ${where.slice(0, 4).map(label).join(", ")}${where.length > 4 ? " …" : ""} gibt es keinen Weg zu einem Endereignis.`,
        hint: "Der Schleife einen Ausgang geben, z. B. ein Entscheidungs-Gateway mit einem Pfad, der weiter zum Ende führt.",
        elementIds: where.length ? where : ids,
      },
      trapped[0],
    );
  };

  for (const s of starts) {
    explore(s);
    if (truncated) break;
  }

  if (!truncated) {
    for (const n of nodes) {
      if (fired.has(n.id) || n.type === "boundaryEvent" && !n.attachedToRef) continue;
      if (n.type === "intermediateCatchEvent" && n.eventDefinition === "link" && (linkTargets.get(n.name ?? "") ?? []).length) {
        // reached via its link throw, if that one fired
        if ([...fired].some((f) => node(f).type === "intermediateThrowEvent" && node(f).name === n.name)) continue;
      }
      if (!ins.get(n.id)!.length && n.type !== "boundaryEvent") continue; // the validator already reports isolated starts
      issues.set(`dead|${n.id}`, {
        kind: "dead",
        severity: "warning",
        message: `${label(n.id)} wird in keinem möglichen Ablauf erreicht.`,
        hint: "Den Weg dorthin prüfen – meist fehlt ein Pfad oder ein Gateway schliesst ihn aus.",
        elementIds: [n.id],
        trace: [],
      });
    }
  }
  // Two tokens at one place show up again everywhere downstream: keep only the first place.
  const unsafe = [...issues.values()].filter((i) => i.kind === "unsafe").map((i) => i.elementIds[0]);
  const downstream = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of outs.get(id) ?? []) {
        if (e.target === to) return true;
        if (!seen.has(e.target)) (seen.add(e.target), stack.push(e.target));
      }
    }
    return false;
  };
  for (const [key, i] of issues) {
    if (i.kind !== "unsafe") continue;
    const at = i.elementIds[0];
    if (unsafe.some((u) => u !== at && downstream(u, at) && !downstream(at, u))) issues.delete(key);
  }
  return { issues: [...issues.values()], states: statesOut.length, truncated };
}

const TYPE_NAME: Record<string, string> = {
  exclusiveGateway: "XOR-Gateway",
  parallelGateway: "Paralleles Gateway",
  inclusiveGateway: "ODER-Gateway",
  eventBasedGateway: "Ereignis-Gateway",
  complexGateway: "Komplexes Gateway",
  endEvent: "Ende",
  startEvent: "Start",
};

const TYPE_LABEL: Record<string, string> = {
  exclusiveGateway: "dem XOR-Gateway",
  parallelGateway: "dem parallelen Gateway",
  inclusiveGateway: "dem ODER-Gateway",
  eventBasedGateway: "dem ereignisbasierten Gateway",
  complexGateway: "dem komplexen Gateway",
  endEvent: "dem Endereignis",
  startEvent: "dem Startereignis",
};
