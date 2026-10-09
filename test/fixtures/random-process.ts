import type { GraphIR } from "../../src/core/ai/graph-schema";

/**
 * Random but realistic process generator (Graph IR as an LLM returns it):
 * sequences, nested XOR/AND/OR blocks, event-based choices, rework loops,
 * early end events, 0–6 lanes; optional cross-links ("unstructured").
 * Deterministic for a given seed.
 */
let seed = 1;
export const setSeed = (s: number) => void (seed = s);
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const VERBS = ["prüfen", "erfassen", "freigeben", "versenden", "anlegen", "bewerten", "dokumentieren", "abstimmen", "bearbeiten", "archivieren", "berechnen", "informieren"];
const OBJECTS = ["Antrag", "Rechnung", "Bestellung", "Vertrag", "Unterlagen", "Angebot", "Reklamation", "Kundendaten", "Lieferschein", "Zahlungsfreigabe für Großkunden", "Ersatzteilbestellung", "Risikobewertung"];
const ROLES = ["Vertrieb", "Einkauf", "Buchhaltung", "Teamleitung", "System", "Kunde", "Lager", "Recht"];

export function randomProcess(n: number, unstructured: boolean): GraphIR {
  const laneCount = pick([0, 1, 2, 3, 3, 4, 5, 6]);
  const lanes = ROLES.slice(0, laneCount).map((name, i) => ({ id: `l${i}`, name }));
  const nodes: GraphIR["nodes"] = [];
  const flows: GraphIR["flows"] = [];
  let id = 0;
  let lane = lanes.length ? lanes[0].id : "";
  const nextLane = () => {
    if (lanes.length && rnd() < 0.35) lane = pick(lanes).id;
    return lane;
  };
  const node = (type: GraphIR["nodes"][number]["type"], name = "", event: GraphIR["nodes"][number]["event"] = "none") => {
    const nid = `n${id++}`;
    nodes.push({ id: nid, type, name, lane: nextLane(), event, source: "", attachedTo: "", interrupting: true });
    return nid;
  };
  const flow = (from: string, to: string, condition = "") => flows.push({ from, to, condition, isDefault: false });
  const task = () => node(pick(["userTask", "userTask", "serviceTask", "manualTask", "sendTask", "task"] as const), `${pick(OBJECTS)} ${pick(VERBS)}`);
  const ends: string[] = [];
  const taskIds: string[] = [];

  /** Builds a block starting after `from`; returns the id of its last node (or null if it ended). */
  const block = (from: string, budget: number, depth: number): string | null => {
    let cur = from;
    while (budget > 0) {
      const r = rnd();
      if (depth < 3 && budget >= 4 && r < 0.3) {
        // XOR decision block
        const k = int(2, 4);
        const gw = node("exclusiveGateway", `${pick(OBJECTS)} ok?`);
        flow(cur, gw);
        const join = node("exclusiveGateway");
        let joined = 0;
        for (let b = 0; b < k; b++) {
          const label = k === 2 ? (b ? "nein" : "ja") : pick(["niedrig", "mittel", "hoch", "sonstiges", "dringend"]) + b;
          if (b > 0 && rnd() < 0.3) {
            // early end
            const t = task();
            flow(gw, t, label);
            const e = node("endEvent", `${pick(OBJECTS)} abgebrochen`);
            flow(t, e);
            ends.push(e);
            continue;
          }
          if (b > 0 && rnd() < 0.2 && taskIds.length) {
            // rework loop back to an earlier task
            const t = task();
            flow(gw, t, label);
            flow(t, pick(taskIds));
            continue;
          }
          const s = node(pick(["userTask", "serviceTask"] as const), `${pick(OBJECTS)} ${pick(VERBS)}`);
          flow(gw, s, label);
          const last = block(s, int(0, Math.max(0, Math.floor(budget / k) - 1)), depth + 1);
          if (last) {
            flow(last, join);
            joined++;
          }
        }
        if (!joined) {
          nodes.splice(nodes.findIndex((x) => x.id === join), 1);
          return null;
        }
        cur = join;
        budget -= 4;
      } else if (depth < 3 && budget >= 4 && r < 0.45) {
        // parallel / inclusive block
        const type = rnd() < 0.75 ? "parallelGateway" : "inclusiveGateway";
        const k = int(2, 3);
        const split = node(type);
        flow(cur, split);
        const join = node(type);
        for (let b = 0; b < k; b++) {
          const s = task();
          flow(split, s, type === "inclusiveGateway" ? `Fall ${b + 1}` : "");
          const last = block(s, int(0, Math.max(0, Math.floor(budget / k) - 1)), depth + 1) ?? s;
          flow(last, join);
        }
        cur = join;
        budget -= 4;
      } else if (depth < 2 && budget >= 4 && r < 0.5) {
        // event-based choice: message vs. timeout
        const eb = node("eventBasedGateway");
        flow(cur, eb);
        const msg = node("intermediateCatchEvent", "Antwort eingegangen", "message");
        const tim = node("intermediateCatchEvent", "Frist abgelaufen", "timer");
        flow(eb, msg);
        flow(eb, tim);
        const e = node("endEvent", "Vorgang verfallen");
        flow(tim, e);
        ends.push(e);
        cur = msg;
        budget -= 3;
      } else {
        const t = task();
        taskIds.push(t);
        flow(cur, t);
        cur = t;
        budget -= 1;
      }
    }
    return cur;
  };

  const start = node("startEvent", "Vorgang eingegangen", "message");
  const last = block(start, n, 0);
  if (last) {
    const e = node("endEvent", "Vorgang abgeschlossen");
    flow(last, e);
  }

  if (unstructured) {
    // cross-links between arbitrary tasks (forward or backward)
    for (let i = 0; i < Math.max(1, Math.floor(n / 10)); i++) {
      const a = pick(taskIds);
      const b = pick(taskIds);
      if (a && b && a !== b) flow(a, b, "Sonderfall");
    }
  }
  return { title: "Stresstest", lang: "de", lanes, nodes, flows, pools: [], messageFlows: [], systems: [], dataObjects: [], assumptions: [], ambiguities: [] };
}

