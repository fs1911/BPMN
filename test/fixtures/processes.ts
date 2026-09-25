import type { GraphIR } from "../../src/core/ai/graph-schema";
import reklamation from "../../samples/llm-reklamation.json";

/**
 * Layout benchmark corpus: realistic Graph IR as the LLM produces it. Written
 * in a compact notation:
 *   nodes: "id:type:Name@lane"   (type shorthands below, lane optional)
 *   flows: "a>b" or "a>b:condition"
 */
const T: Record<string, string> = {
  S: "startEvent",
  E: "endEvent",
  u: "userTask",
  s: "serviceTask",
  m: "manualTask",
  snd: "sendTask",
  t: "task",
  X: "exclusiveGateway",
  P: "parallelGateway",
  O: "inclusiveGateway",
  EB: "eventBasedGateway",
  C: "intermediateCatchEvent",
};

function g(title: string, lanes: string[], nodes: string[], flows: string[], events: Record<string, string> = {}): GraphIR {
  const laneIds = Object.fromEntries(lanes.map((l, i) => [l, `l${i + 1}`]));
  return {
    title,
    lang: "de",
    lanes: lanes.map((name, i) => ({ id: `l${i + 1}`, name })),
    nodes: nodes.map((spec) => {
      const [id, type, rest = ""] = spec.split(":");
      const [name, lane = ""] = rest.split("@");
      return {
        id,
        type: (T[type] ?? type) as GraphIR["nodes"][number]["type"],
        name,
        lane: lane ? laneIds[lane] : "",
        event: (events[id] ?? "none") as GraphIR["nodes"][number]["event"],
        source: name,
      };
    }),
    flows: flows.map((f) => {
      const [edge, condition = ""] = f.split(":");
      const [from, to] = edge.split(">");
      return { from, to, condition, isDefault: false };
    }),
    systems: [],
    dataObjects: [],
    assumptions: [],
    ambiguities: [],
  };
}

export const BESTELLUNG = g(
  "Bestellprozess",
  ["Anforderer", "Einkauf", "Abteilungsleitung", "System", "Buchhaltung"],
  [
    "s:S:Bedarf festgestellt@Anforderer",
    "t1:u:Bestellanforderung erfassen@Anforderer",
    "t2:u:Anforderung prüfen@Einkauf",
    "g1:X:Vollständig?@Einkauf",
    "t3:u:Anforderung ergänzen@Anforderer",
    "g2:X:Betrag über 5.000 €?@Einkauf",
    "t4:u:Anforderung freigeben@Abteilungsleitung",
    "g3:X:Freigegeben?@Abteilungsleitung",
    "e1:E:Anforderung abgelehnt@Abteilungsleitung",
    "j1:X:@Einkauf",
    "t5:s:Bestellung anlegen@System",
    "t6:snd:Bestellung an Lieferant senden@Einkauf",
    "c1:C:Ware erhalten@Einkauf",
    "p1:P:@Einkauf",
    "t7:s:Wareneingang buchen@System",
    "t8:u:Rechnung prüfen@Buchhaltung",
    "p2:P:@Buchhaltung",
    "t9:u:Zahlung freigeben@Buchhaltung",
    "e2:E:Bestellung abgeschlossen@Buchhaltung",
  ],
  [
    "s>t1", "t1>t2", "t2>g1", "g1>t3:nein", "t3>t2", "g1>g2:ja", "g2>t4:ja", "t4>g3", "g3>e1:nein", "g3>j1:ja",
    "g2>j1:nein", "j1>t5", "t5>t6", "t6>c1", "c1>p1", "p1>t7", "p1>t8", "t7>p2", "t8>p2", "p2>t9", "t9>e2",
  ],
  { c1: "message" },
);

export const ONBOARDING = g(
  "Onboarding",
  ["HR", "IT", "Facility", "Teamleitung"],
  [
    "s:S:Vertrag unterschrieben@HR",
    "t1:u:Personalakte anlegen@HR",
    "p1:P:@HR",
    "t2:s:Benutzerkonten anlegen@IT",
    "t3:m:Laptop bereitstellen@IT",
    "t4:m:Arbeitsplatz einrichten@Facility",
    "t5:u:Einarbeitungsplan erstellen@Teamleitung",
    "p2:P:@Teamleitung",
    "t6:u:Mitarbeiter begrüßen@Teamleitung",
    "c1:C:Probezeit endet@Teamleitung",
    "g1:X:Probezeit bestanden?@Teamleitung",
    "e1:E:Onboarding abgeschlossen@Teamleitung",
    "t7:u:Kündigung vorbereiten@HR",
    "e2:E:Arbeitsverhältnis beendet@HR",
  ],
  ["s>t1", "t1>p1", "p1>t2", "t2>t3", "p1>t4", "p1>t5", "t3>p2", "t4>p2", "t5>p2", "p2>t6", "t6>c1", "c1>g1", "g1>e1:ja", "g1>t7:nein", "t7>e2"],
  { c1: "timer" },
);

export const URLAUB = g(
  "Urlaubsantrag",
  [],
  [
    "s:S:Urlaub geplant",
    "t1:u:Antrag stellen",
    "t2:u:Antrag prüfen",
    "g1:X:Genehmigt?",
    "t3:s:Urlaub eintragen",
    "e1:E:Urlaub genehmigt",
    "g2:X:Antrag anpassen?",
    "t4:u:Antrag überarbeiten",
    "e2:E:Antrag abgelehnt",
  ],
  ["s>t1", "t1>t2", "t2>g1", "g1>t3:ja", "t3>e1", "g1>g2:nein", "g2>t4:ja", "t4>t2", "g2>e2:nein"],
);

export const KREDIT = g(
  "Kreditantrag",
  ["Kunde", "Berater", "Risikomanagement", "System"],
  [
    "s:S:Kreditanfrage eingegangen@Berater",
    "t1:snd:Unterlagen anfordern@Berater",
    "eb:EB:@Berater",
    "c1:C:Unterlagen eingegangen@Berater",
    "c2:C:14 Tage vergangen@Berater",
    "e0:E:Anfrage verfallen@Berater",
    "t2:s:Bonität prüfen@System",
    "t3:u:Unterlagen prüfen@Berater",
    "g1:X:Vollständig?@Berater",
    "t4:snd:Unterlagen nachfordern@Berater",
    "t5:u:Risiko bewerten@Risikomanagement",
    "g2:X:Risiko?@Risikomanagement",
    "o1:O:@Berater",
    "t6:u:Grundschuld eintragen@Berater",
    "t7:u:Bürgschaft beibringen@Kunde",
    "o2:O:@Berater",
    "e1:E:Kredit abgelehnt@Risikomanagement",
    "j1:X:@System",
    "t8:s:Vertrag erstellen@System",
    "t9:u:Vertrag unterschreiben@Kunde",
    "t10:s:Auszahlung veranlassen@System",
    "e2:E:Kredit ausgezahlt@System",
  ],
  [
    "s>t1", "t1>eb", "eb>c1", "eb>c2", "c2>e0", "c1>t2", "t2>t3", "t3>g1", "g1>t4:nein", "t4>eb", "g1>t5:ja", "t5>g2",
    "g2>j1:niedrig", "g2>o1:mittel", "g2>e1:hoch", "o1>t6:Grundschuld", "o1>t7:Bürgschaft", "t6>o2", "t7>o2", "o2>j1",
    "j1>t8", "t8>t9", "t9>t10", "t10>e2",
  ],
  { s: "message", c1: "message", c2: "timer" },
);

export const REKLAMATION = reklamation as GraphIR;

export const CORPUS: Record<string, GraphIR> = {
  reklamation: REKLAMATION,
  bestellung: BESTELLUNG,
  onboarding: ONBOARDING,
  urlaub: URLAUB,
  kredit: KREDIT,
};
