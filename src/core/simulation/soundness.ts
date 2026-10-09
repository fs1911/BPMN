import type { BpmnModel, Edge, FlowNode } from "../model";
import { type Marking, XOR_LIKE, buildNet } from "./net";
import { namer } from "./names";

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


interface State {
  key: string;
  marking: Marking;
  parent?: number;
  via?: string; // node fired to get here
  succ: number[];
}

function analyzeScope(model: BpmnModel, scope: string, budget: number, deadline: number): SoundnessResult {
  const net = buildNet(model, scope);
  if (!net) return { issues: [], states: 0, truncated: false };
  const { nodes, ins, outs, starts, node } = net;
  const { label, name } = namer(net);
  const linkCatches = new Map<string, FlowNode[]>();
  for (const n of nodes) {
    if (n.type === "intermediateCatchEvent" && n.eventDefinition === "link") (linkCatches.get(n.name ?? "") ?? linkCatches.set(n.name ?? "", []).get(n.name ?? "")!).push(n);
  }

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
  const fire = (n: FlowNode, m: Marking): { marking: Marking; overflow?: Edge; fired: string[] }[] =>
    net.firings(n, m).map((f) => ({ ...net.apply(n, m, f), fired: [n.id, ...f.extra] }));

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
      if (n.type === "intermediateCatchEvent" && n.eventDefinition === "link" && (linkCatches.get(n.name ?? "") ?? []).length) {
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
