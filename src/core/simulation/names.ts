import type { ScopeNet } from "./net";

/**
 * German names of elements in simulation messages. Unnamed elements (joins,
 * splits the AI left without a question) get their place in the flow, so two
 * of them are never both just "das ODER-Gateway":
 *   "ODER-Gateway vor „Sicherheitskonzept prüfen“".
 */
export interface Namer {
  /** nominative, for lists: "„Antrag prüfen“" / "ODER-Gateway vor „…“" */
  name(id: string): string;
  /** dative, after "bei"/"vor"/"nach": "„Antrag prüfen“" / "dem ODER-Gateway vor „…“" */
  label(id: string): string;
  /** "bei „Antrag prüfen“" / "beim ODER-Gateway vor „…“" */
  at(id: string): string;
}

const TYPE: Record<string, [nominative: string, dative: string]> = {
  exclusiveGateway: ["XOR-Gateway", "dem XOR-Gateway"],
  parallelGateway: ["Paralleles Gateway", "dem parallelen Gateway"],
  inclusiveGateway: ["ODER-Gateway", "dem ODER-Gateway"],
  eventBasedGateway: ["Ereignis-Gateway", "dem ereignisbasierten Gateway"],
  complexGateway: ["Komplexes Gateway", "dem komplexen Gateway"],
  startEvent: ["Start", "dem Startereignis"],
  endEvent: ["Ende", "dem Endereignis"],
  intermediateCatchEvent: ["Zwischenereignis", "dem Zwischenereignis"],
  intermediateThrowEvent: ["Zwischenereignis", "dem Zwischenereignis"],
  boundaryEvent: ["Grenzereignis", "dem Grenzereignis"],
};

export function namer(net: ScopeNet): Namer {
  const { node, ins, outs } = net;
  const own = (id: string) => {
    const n = node(id)?.name?.trim();
    return n ? `„${n.replace(/\s+/g, " ")}“` : undefined;
  };
  /** nearest named element walking along the flow (through unnamed ones). */
  const nearest = (id: string, dir: "in" | "out"): string | undefined => {
    const seen = new Set([id]);
    let frontier = [id];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: string[] = [];
      for (const x of frontier) {
        for (const e of (dir === "in" ? ins : outs).get(x) ?? []) {
          const y = dir === "in" ? e.source : e.target;
          if (seen.has(y)) continue;
          seen.add(y);
          if (own(y)) return own(y);
          next.push(y);
        }
      }
      frontier = next;
    }
    return undefined;
  };
  const place = (id: string) => {
    const joins = (ins.get(id)?.length ?? 0) > 1 && (outs.get(id)?.length ?? 0) <= 1;
    const before = nearest(id, "out");
    const after = nearest(id, "in");
    if (joins && before) return ` vor ${before}`;
    if (after) return ` nach ${after}`;
    if (before) return ` vor ${before}`;
    return "";
  };
  const type = (id: string) => TYPE[node(id)?.type ?? ""] ?? ["Aufgabe", "der Aufgabe"];
  return {
    name: (id) => own(id) ?? `${type(id)[0]}${place(id)}`,
    label: (id) => own(id) ?? `${type(id)[1]}${place(id)}`,
    at: (id) => {
      if (own(id)) return `bei ${own(id)}`;
      const dative = type(id)[1];
      return `${dative.startsWith("dem ") ? `beim ${dative.slice(4)}` : `bei ${dative}`}${place(id)}`;
    },
  };
}
