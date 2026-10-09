import type { BpmnModel, Edge, FlowNode } from "../model";
import { type Firing, type Marking, type ScopeNet, buildNet } from "./net";

/**
 * Automatic run-through: plays the process along every combination of
 * decisions, one path ("Weg") after the other, as an animation script.
 *
 * Execution goes in rounds: in each round every element that can run does so
 * (parallel branches advance together). Paths are chosen so that every way out
 * of every decision (XOR/OR split, event-based gateway, boundary event) is
 * played at least once, and every loop once. Problems that need one specific
 * combination of decisions are found by the exhaustive check (soundness.ts),
 * which the UI shows alongside.
 *
 * Uses the same token rules as the exhaustive check (net.ts).
 */

export interface SimFiring {
  node: string;
  /** boundary / link events firing with it */
  extra: string[];
  consumed: string[];
  produced: string[];
}

export interface SimChoice {
  node: string;
  /** e.g. "Garantiefall? = nein" */
  label: string;
}

export type ScenarioOutcome = "ok" | "deadlock" | "unsafe" | "loop" | "too-long";

export interface Scenario {
  /** start event of this path */
  start: string;
  choices: SimChoice[];
  /** rounds of simultaneous firings, in order */
  rounds: SimFiring[][];
  outcome: ScenarioOutcome;
  /** where it ended badly (stuck tokens / double run) */
  problemAt: string[];
  /** German one-line verdict */
  verdict: string;
}

export interface ScenarioResult {
  scenarios: Scenario[];
  /** more paths exist than were played */
  truncated: boolean;
}

interface Options {
  maxScenarios?: number;
  maxRounds?: number;
}

export function enumerateScenarios(model: BpmnModel, opts: Options = {}): ScenarioResult {
  const maxScenarios = opts.maxScenarios ?? 40;
  const maxRounds = opts.maxRounds ?? 150;
  const scenarios: Scenario[] = [];
  let truncated = false;
  // Pools with their own process; subprocess contents run as one step of their parent.
  const scopes = Object.keys(model.processes).filter((p) => Object.values(model.nodes).some((n) => n.parent === p));
  for (const scope of scopes) {
    const net = buildNet(model, scope);
    if (!net) continue;
    for (const start of net.starts) {
      const r = runFrom(net, start, maxScenarios - scenarios.length, maxRounds);
      scenarios.push(...r.scenarios);
      if (r.truncated || scenarios.length >= maxScenarios) {
        truncated = true;
        return { scenarios, truncated };
      }
    }
  }
  return { scenarios, truncated };
}

/**
 * Paths chosen for coverage: every way out of every decision appears in at
 * least one path. Each path takes, at a decision, a way not covered yet; if
 * all are covered, one that leads towards a decision with uncovered ways; on a
 * repeated visit (loop) only a way not taken yet in this path, so every loop
 * is run once and then left. Stops when a path adds nothing new.
 */
function runFrom(net: ScopeNet, start: FlowNode, budget: number, maxRounds: number): { scenarios: Scenario[]; truncated: boolean } {
  const { node, outs } = net;
  const out: Scenario[] = [];
  const name = (id: string) => {
    const n = node(id);
    return n?.name?.trim() ? `„${n.name.trim().replace(/\s+/g, " ")}“` : TYPE_NAME[n?.type ?? ""] ?? id;
  };
  /** "bei „Antrag prüfen“" / "beim parallelen Gateway" */
  const at = (id: string) => {
    const n = node(id);
    return n?.name?.trim() ? `bei „${n.name.trim().replace(/\s+/g, " ")}“` : AT[n?.type ?? ""] ?? `bei ${id}`;
  };
  const wayKey = (f: Firing) => [...f.produce.map((e) => e.id), ...f.extra].sort().join("+");
  const wayLabel = (n: FlowNode, f: Firing) => {
    if (f.extra.length && node(f.extra[0])?.type === "boundaryEvent") return `${name(n.id)}: ${name(f.extra[0])} tritt ein`;
    const text = f.produce.map((e) => e.name?.trim() || e.condition?.trim() || name(e.target)).join(" + ");
    return `${name(n.id)} = ${text || "Ende"}`;
  };

  // All ways out of every decision (static), to know what is still uncovered.
  const decisionWays = new Map<string, Set<string>>();
  const covered = new Set<string>(); // "node|way"
  const isDecision = (n: FlowNode) => outs.get(n.id)!.length > 1 && n.type !== "parallelGateway" && n.type !== "complexGateway";
  const uncoveredAt = (id: string) => {
    const ways = decisionWays.get(id);
    return !!ways && [...ways].some((w) => !covered.has(`${id}|${w}`));
  };
  /**
   * Steps from a way to the nearest decision that still has uncovered (or
   * never seen) ways — not passing back through the deciding element itself,
   * so a loop back does not count as "leading there". Infinity if none.
   */
  const distanceToUncovered = (f: Firing, from: string) => {
    const seen = new Set<string>([from]);
    let frontier = f.produce.map((e) => e.target);
    for (let d = 0; frontier.length; d++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (uncoveredAt(id) || (!decisionWays.has(id) && isDecision(node(id)))) return d;
        for (const e of outs.get(id) ?? []) nextFrontier.push(e.target);
      }
      frontier = nextFrontier;
    }
    return Infinity;
  };
  let attempt = 0;
  /** Steps until this way comes back to the deciding element (Infinity: a real exit). */
  const stepsBack = (f: Firing, id: string) => {
    const seen = new Set<string>();
    let frontier = f.produce.map((e) => e.target);
    for (let d = 0; frontier.length; d++) {
      const next: string[] = [];
      for (const x of frontier) {
        if (x === id) return d;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const e of outs.get(x) ?? []) next.push(e.target);
      }
      frontier = next;
    }
    return Infinity;
  };

  const runOne = (): Scenario | undefined => {
    let marking: Marking = new Map(outs.get(start.id)!.map((e) => [e.id, 1]));
    const rounds: SimFiring[][] = [[{ node: start.id, extra: [], consumed: [], produced: outs.get(start.id)!.map((e) => e.id) }]];
    const choices: SimChoice[] = [];
    const takenInPath = new Map<string, Set<string>>();
    const visitsInPath = new Map<string, number>();
    let unsafeAt: string | undefined;
    let newCoverage = false;
    const done = (outcome: ScenarioOutcome, problemAt: string[], verdict: string): Scenario | undefined => {
      if (unsafeAt && outcome === "ok") {
        outcome = "unsafe";
        problemAt = [unsafeAt];
        verdict = `Läuft ab ${name(unsafeAt)} doppelt ab – zwei Pfade kommen dort gleichzeitig an.`;
      }
      if (!newCoverage && out.length) return undefined; // nothing new: coverage complete
      return { start: start.id, choices, rounds, outcome, problemAt, verdict };
    };

    for (;;) {
      if (!marking.size) {
        const ends = [...new Set(rounds.flat().filter((f) => node(f.node).type === "endEvent").map((f) => f.node))];
        return done("ok", [], `Kommt sauber zum Ende${ends.length ? ` bei ${ends.map(name).join(", ")}` : ""}.`);
      }
      if (rounds.length >= maxRounds) return done("too-long", [], "Nach sehr vielen Schritten abgebrochen.");
      const round: SimFiring[] = [];
      let next = marking;
      let any = false;
      let loopEnd = false;
      for (const n of net.nodes) {
        const fs = net.firings(n, marking);
        if (!fs.length) continue;
        any = true;
        const firstConsume = fs[0].consume.map((e) => e.id).join();
        let options = fs.filter((f) => f.consume.map((e) => e.id).join() === firstConsume);
        let pick = options[0];
        if (options.length > 1) {
          if (!decisionWays.has(n.id)) decisionWays.set(n.id, new Set(options.map(wayKey)));
          const taken = takenInPath.get(n.id);
          const visits = (visitsInPath.get(n.id) ?? 0) + 1;
          visitsInPath.set(n.id, visits);
          if (taken) {
            const untaken = options.filter((f) => !taken.has(wayKey(f)));
            // Every way taken already: leave by a way that does not lead back here
            // (nested loops: take the way whose way back is longest — the outer exit, not the inner loop)
            const far = [...options].sort((a, b) => stepsBack(b, n.id) - stepsBack(a, n.id));
            options = untaken.length ? untaken : far.slice(0, 1);
          }
          if (!options.length || visits > 4) {
            loopEnd = true;
            break;
          }
          const fresh = options.filter((f) => !covered.has(`${n.id}|${wayKey(f)}`));
          if (fresh.length) pick = fresh[0];
          else {
            // all covered here: head for the nearest uncovered decision; vary between attempts
            const ranked = options.map((f) => ({ f, d: distanceToUncovered(f, n.id) })).sort((a, b) => a.d - b.d);
            const best = ranked.filter((r) => r.d === ranked[0].d);
            pick = best[attempt % best.length].f;
          }
          const key = `${n.id}|${wayKey(pick)}`;
          if (!covered.has(key)) (covered.add(key), (newCoverage = true));
          const set = takenInPath.get(n.id) ?? takenInPath.set(n.id, new Set()).get(n.id)!;
          set.delete(wayKey(pick));
          set.add(wayKey(pick)); // most recent last
          choices.push({ node: n.id, label: wayLabel(n, pick) });
        }
        const r = net.apply(n, next, pick);
        next = r.marking;
        if (r.overflow && !unsafeAt) unsafeAt = r.overflow.target;
        round.push({ node: n.id, extra: pick.extra, consumed: pick.consume.map((e) => e.id), produced: pick.produce.map((e) => e.id) });
      }
      if (loopEnd) return done("loop", [], "Schleife mehrfach durchlaufen – hier abgebrochen, weitere Wiederholungen werden nicht gezeigt.");
      if (!any) {
        const stuck = [...new Set([...marking.keys()].map((e) => findEdge(net, e)?.target).filter((x): x is string => !!x))];
        const earlyEnd = rounds.flat().find((f) => node(f.node).type === "endEvent");
        const why = earlyEnd ? ` – ein paralleler Pfad endete vorher bei ${name(earlyEnd.node)}` : "";
        return done("deadlock", stuck, `Bleibt ${stuck.map(at).join(", ")} stehen${why}. Der Prozess kommt nicht zum Ende.`);
      }
      marking = next;
      rounds.push(round);
      // Two paths meeting at an element that expects one (XOR merge, task) is a double run.
      if (!unsafeAt) {
        for (const n of net.nodes) {
          if (n.type === "parallelGateway" || n.type === "inclusiveGateway" || n.type === "complexGateway") continue;
          if (net.ins.get(n.id)!.filter((e) => (marking.get(e.id) ?? 0) > 0).length >= 2) {
            unsafeAt = n.id;
            break;
          }
        }
      }
    }
  };

  // Paths that add nothing new are not kept; a few retries vary the route before giving up.
  let fruitless = 0;
  while (fruitless < 4) {
    if (out.length >= budget) return { scenarios: out, truncated: true };
    const sc = runOne();
    if (sc) {
      out.push(sc);
      fruitless = 0;
    } else fruitless++;
    attempt++;
  }
  return { scenarios: out, truncated: false };
}

function findEdge(net: ScopeNet, id: string): Edge | undefined {
  for (const list of net.outs.values()) for (const e of list) if (e.id === id) return e;
  return undefined;
}

const AT: Record<string, string> = {
  exclusiveGateway: "beim XOR-Gateway",
  parallelGateway: "beim parallelen Gateway",
  inclusiveGateway: "beim ODER-Gateway",
  eventBasedGateway: "beim Ereignis-Gateway",
  complexGateway: "beim komplexen Gateway",
  endEvent: "beim Endereignis",
};

const TYPE_NAME: Record<string, string> = {
  exclusiveGateway: "XOR-Gateway",
  parallelGateway: "Paralleles Gateway",
  inclusiveGateway: "ODER-Gateway",
  eventBasedGateway: "Ereignis-Gateway",
  complexGateway: "Komplexes Gateway",
  endEvent: "Ende",
  startEvent: "Start",
};
