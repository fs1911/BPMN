import type { GraphIR } from "../../src/core/ai/graph-schema";
import reklamation from "../../samples/llm-reklamation.json";

/**
 * Layout benchmark corpus: realistic Graph IR as the LLM produces it. Written
 * in a compact notation:
 *   nodes: "id:type:Name@lane"   (type shorthands below, lane optional;
 *          boundary events "id:B:Name@host", non-interrupting "id:BN:Name@host")
 *   flows: "a>b" or "a>b:condition" ("a>b:condition!" = default flow)
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
  B: "boundaryEvent",
  BN: "boundaryEvent",
};

function g(title: string, lanes: string[], nodes: string[], flows: string[], events: Record<string, string> = {}): GraphIR {
  const laneIds = Object.fromEntries(lanes.map((l, i) => [l, `l${i + 1}`]));
  return {
    title,
    lang: "de",
    lanes: lanes.map((name, i) => ({ id: `l${i + 1}`, name })),
    nodes: nodes.map((spec) => {
      const [id, type, rest = ""] = spec.split(":");
      const [name, at = ""] = rest.split("@");
      const boundary = type === "B" || type === "BN";
      return {
        id,
        type: (T[type] ?? type) as GraphIR["nodes"][number]["type"],
        name,
        lane: at && !boundary ? laneIds[at] : "",
        event: (events[id] ?? "none") as GraphIR["nodes"][number]["event"],
        source: name,
        attachedTo: boundary ? at : "",
        interrupting: type !== "BN",
      };
    }),
    flows: flows.map((f) => {
      const [edge, cond = ""] = f.split(":");
      const [from, to] = edge.split(">");
      return { from, to, condition: cond.replace(/!$/, ""), isDefault: cond.endsWith("!") };
    }),
    pools: [],
    messageFlows: [],
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

/** Real user process (Swiss construction tender), reconstructed 1:1 from the generated PDF. */
export const AUSSCHREIBUNG = g(
  "Ausschreibung prüfen, kalkulieren und Offerte einreichen",
  ["Akquisition", "Kalkulation", "Bau/Projektleitung", "Einkauf", "Geschäftsleitung", "Kalkulationssoftware"],
  [
    "s1:S:Ausschreibung eingegangen@Akquisition",
    "t2:u:Anfrage und Unterlagen erfassen@Akquisition",
    "t3:s:Vorgang anlegen und Unterlagen prüfen@Kalkulationssoftware",
    "g4:X:Unterlagen vollständig und lesbar?@Kalkulationssoftware",
    "t5:snd:Fehlende Unterlagen anfordern@Akquisition",
    "c6:C:Unterlagen eingegangen@Akquisition",
    "t7:u:Bearbeitbarkeit prüfen@Kalkulation",
    "g8:X:Ausschreibung bearbeiten?@Kalkulation",
    "t9:snd:Verzicht mitteilen@Akquisition",
    "t10:u:Vorgang schliessen@Akquisition",
    "e11:E:Keine Offerte@Akquisition",
    "p12:P:@Kalkulation",
    "t13:u:Leistungsverzeichnis analysieren@Kalkulation",
    "t14:u:Bauablauf und Machbarkeit prüfen@Bau/Projektleitung",
    "t15:u:Preise anfragen@Einkauf",
    "t16:s:Preisgrundlagen bereitstellen@Kalkulationssoftware",
    "p17:P:@Kalkulation",
    "g18:X:Unklarheiten offen?@Kalkulation",
    "t19:snd:Fragen an Auftraggeber stellen@Akquisition",
    "t20:u:Antwort erfassen und Grundlagen aktualisieren@Kalkulation",
    "t21:u:Geänderte Positionen prüfen@Kalkulation",
    "t22:u:Preise und Angebotssumme ermitteln@Kalkulation",
    "t23:s:Angebotssumme berechnen und prüfen@Kalkulationssoftware",
    "g24:X:Kalkulation rechnerisch vollständig?@Kalkulationssoftware",
    "t25:u:Markierte Positionen korrigieren@Kalkulation",
    "p26:P:@Kalkulation",
    "t27:u:Ausführbarkeit und Risiken prüfen@Bau/Projektleitung",
    "t28:u:Lieferantenpreise prüfen@Einkauf",
    "p29:P:@Kalkulation",
    "g30:X:Anpassungen erforderlich?@Kalkulation",
    "t31:u:Betroffene Positionen überarbeiten@Kalkulation",
    "t32:s:Offertfassung erstellen@Kalkulationssoftware",
    "t33:u:Offerte prüfen@Geschäftsleitung",
    "g34:X:Offerte freigegeben?@Geschäftsleitung",
    "t35:snd:Absage mitteilen@Akquisition",
    "t36:u:Vorgang schliessen@Akquisition",
    "e37:E:Keine Offerte@Akquisition",
    "t38:u:Freigabeantrag kommentieren@Geschäftsleitung",
    "t39:u:Offerte überarbeiten@Kalkulation",
    "t40:s:Offertdateien erzeugen@Kalkulationssoftware",
    "t41:snd:Offerte einreichen@Akquisition",
    "t42:s:Abgabe protokollieren@Kalkulationssoftware",
    "g43:X:Fristgerecht und vollständig eingereicht?@Kalkulationssoftware",
    "e44:E:Offerte eingereicht und dokumentiert@Akquisition",
    "t45:u:Korrekturmöglichkeit klären@Akquisition",
    "g46:X:Korrektur zulässig?@Akquisition",
    "t47:u:Einreichung korrigieren@Akquisition",
    "t48:u:Nicht erfolgreichen Abschluss dokumentieren@Akquisition",
    "e49:E:Offerte nicht gültig eingereicht@Akquisition",
  ],
  [
    "s1>t2", "t2>t3", "t3>g4", "g4>t5:nein", "g4>t7:ja", "t5>c6", "c6>t3", "t7>g8", "g8>t9:nein", "g8>p12:ja",
    "t9>t10", "t10>e11", "p12>t13", "p12>t14", "p12>t15", "p12>t16", "t13>p17", "t14>p17", "t15>p17", "t16>p17",
    "p17>g18", "g18>t19:ja", "g18>t22:nein", "t19>t20", "t20>t21", "t21>g18", "t22>t23", "t23>g24", "g24>t25:nein",
    "g24>p26:ja", "t25>t23", "p26>t27", "p26>t28", "t27>p29", "t28>p29", "p29>g30", "g30>t31:ja", "g30>t32:nein",
    "t31>t23", "t32>t33", "t33>g34", "g34>t35:nein, kein Angebot", "g34>t38:nein, Überarbeitung möglich", "g34>t40:ja",
    "t35>t36", "t36>e37", "t38>t39", "t39>t23", "t40>t41", "t41>t42", "t42>g43", "g43>e44:ja", "g43>t45:nein",
    "t45>g46", "g46>t47:ja", "g46>t48:nein", "t47>t42", "t48>e49",
  ],
  { s1: "message", c6: "message" },
);
// …with the client as external pool and the message flows the prompt asked for
AUSSCHREIBUNG.pools = [{ id: "p_ag", name: "Auftraggeber" }];
AUSSCHREIBUNG.messageFlows = [
  { from: "p_ag", to: "s1", name: "Ausschreibung" },
  { from: "t5", to: "p_ag", name: "Nachforderung" },
  { from: "p_ag", to: "c6", name: "Unterlagen" },
  { from: "t9", to: "p_ag", name: "Verzicht" },
  { from: "t19", to: "p_ag", name: "Rückfragen" },
  { from: "t35", to: "p_ag", name: "Absage" },
  { from: "t41", to: "p_ag", name: "Offerte" },
  { from: "t45", to: "p_ag", name: "Korrekturanfrage" },
];

/**
 * A real process from the field (construction stage): loops inside a parallel
 * block, an OR split/join with a default flow, a rework jump back to the AND
 * split and an interrupting boundary event. It is sound — an earlier OR-join
 * rule reported a deadlock here (the norm's table 13.3 says otherwise).
 */
export const BAUETAPPE = g(
  "Bauetappe vorbereiten, ausführen und abnehmen",
  ["Bauführer", "Polier", "SIBE", "Einkauf"],
  [
    "s:S:Bauauftrag eingegangen@Bauführer",
    "a1:u:Auftrag und Ausführungsunterlagen prüfen@Bauführer",
    "x1:X:Unterlagen vollständig?@Bauführer",
    "a2:u:Fehlende Unterlagen beschaffen@Bauführer",
    "p1:P:@Bauführer",
    "b1:u:Personal und Geräte planen@Polier",
    "x2:X:Ressourcen verfügbar?@Polier",
    "b2:u:Ersatzressourcen organisieren@Polier",
    "c1:u:Materialverfügbarkeit prüfen@Einkauf",
    "x3:X:Material auf Lager?@Einkauf",
    "c2:u:Material reservieren@Einkauf",
    "c3:u:Material bestellen@Einkauf",
    "c4:u:Liefertermin prüfen@Einkauf",
    "x4:X:Liefertermin ausreichend?@Einkauf",
    "c5:u:Alternativen bewerten@Einkauf",
    "x5:X:Alternative möglich?@Einkauf",
    "c6:u:Ersatzmaterial bestellen@Einkauf",
    "c7:u:Etappentermin anpassen@Bauführer",
    "m3:X:@Einkauf",
    "d1:u:Gefährdungen beurteilen@SIBE",
    "o1:O:Welche Massnahmen?@SIBE",
    "d2:u:Technische Schutzmassnahmen planen@SIBE",
    "d3:u:Organisatorische Schutzmassnahmen planen@SIBE",
    "o2:O:@SIBE",
    "d4:u:Sicherheitskonzept prüfen@SIBE",
    "x6:X:Konzept ausreichend?@SIBE",
    "p2:P:@Bauführer",
    "e1:u:Etappe zur Ausführung prüfen@Bauführer",
    "x7:X:Freigabe erteilt?@Bauführer",
    "e2:u:Nachbesserung koordinieren@Bauführer",
    "p3:P:@Bauführer",
    "f1:m:Baustelle einrichten@Polier",
    "f2:u:Mitarbeitende instruieren@SIBE",
    "p4:P:@Polier",
    "f3:m:Bauarbeiten ausführen@Polier",
    "bm:B:Sicherheitsmangel gemeldet@f3",
    "g1:m:Arbeiten stoppen und Bereich sichern@Polier",
    "g2:u:Massnahmen festlegen@SIBE",
    "g3:m:Massnahmen umsetzen@Polier",
    "g4:u:Wiederaufnahme prüfen@SIBE",
    "x8:X:Wiederaufnahme zulässig?@SIBE",
    "p5:P:@Polier",
    "h1:u:Ausführungsqualität prüfen@Polier",
    "h2:u:Leistungen und Nachweise prüfen@Bauführer",
    "p6:P:@Bauführer",
    "h3:u:Prüfergebnisse bewerten@Bauführer",
    "x9:X:Mängel vorhanden?@Bauführer",
    "h4:m:Mängel beheben@Polier",
    "h5:u:Bauetappe abnehmen@Bauführer",
    "h6:u:Dokumentation abschliessen@Bauführer",
    "e:E:Bauetappe abgeschlossen@Bauführer",
  ],
  [
    "s>a1", "a1>x1", "x1>a2:nein", "a2>a1", "x1>p1:ja",
    "p1>b1", "p1>c1", "p1>d1",
    "b1>x2", "x2>b2:nein", "b2>b1", "x2>p2:ja",
    "c1>x3", "x3>c2:ja", "x3>c3:nein", "c3>c4", "c4>x4", "x4>m3:ja", "x4>c5:nein", "c5>x5", "x5>c6:ja", "x5>c7:nein", "c7>c4",
    "c2>m3", "c6>m3", "m3>p2",
    "d1>o1", "o1>d2:technische Massnahmen nötig", "o1>d3:organisatorische Massnahmen nötig", "o1>o2:keine Zusatzmassnahmen!",
    "d2>o2", "d3>o2", "o2>d4", "d4>x6", "x6>d1:nein", "x6>p2:ja",
    "p2>e1", "e1>x7", "x7>e2:nein", "e2>p1", "x7>p3:ja",
    "p3>f1", "p3>f2", "f1>p4", "f2>p4", "p4>f3",
    "bm>g1", "g1>g2", "g2>g3", "g3>g4", "g4>x8", "x8>g2:nein", "x8>f3:ja",
    "f3>p5", "p5>h1", "p5>h2", "h1>p6", "h2>p6", "p6>h3", "h3>x9", "x9>h4:ja", "h4>p5", "x9>h5:nein", "h5>h6", "h6>e",
  ],
  { s: "message", bm: "message" },
);

export const REKLAMATION = { pools: [], messageFlows: [], ...reklamation } as unknown as GraphIR;

export const CORPUS: Record<string, GraphIR> = {
  reklamation: REKLAMATION,
  bestellung: BESTELLUNG,
  onboarding: ONBOARDING,
  urlaub: URLAUB,
  kredit: KREDIT,
  ausschreibung: AUSSCHREIBUNG,
  bauetappe: BAUETAPPE,
};
