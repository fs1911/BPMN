import { Ambiguity, BranchIR, ProcessIR, StepIR, StepKind } from "./types";

/**
 * Deterministic natural-language → IR extractor.
 *
 * This is a rule-based pipeline (segmentation → classification → role/system/
 * data detection → branch & loop detection → normalization). It is fully
 * offline and unit-tested, and serves as the default extractor. An LLM-backed
 * extractor (see llm.ts) can replace it when an API key is configured; both
 * emit the same IR so the rest of the pipeline is identical.
 */

const ROLE_HINTS = [
  "manager",
  "head",
  "clerk",
  "officer",
  "agent",
  "analyst",
  "accountant",
  "approver",
  "reviewer",
  "supervisor",
  "director",
  "customer",
  "client",
  "supplier",
  "vendor",
  "applicant",
  "employee",
  "specialist",
  "engineer",
  "controller",
  "auditor",
  "procurement",
  "finance",
  "legal",
  "sales",
  "support",
  "quality",
  "warehouse",
  "site management",
  "department head",
  "team lead",
  "operator",
  // German
  "sachbearbeiter", "sachbearbeiterin", "einkäufer", "einkauf", "abteilungsleiter",
  "leiter", "leiterin", "mitarbeiter", "mitarbeiterin", "kunde", "kundin",
  "lieferant", "antragsteller", "antragstellerin", "prüfer", "prüferin", "freigeber",
  "buchhalter", "buchhaltung", "vertrieb", "lager", "fachbereich", "geschäftsführer",
  "teamleiter", "qualität", "recht", "finanzen", "kundendienst", "disponent",
  "techniker", "berater",
];

const SYSTEM_HINTS = [
  "system",
  "erp",
  "sap",
  "crm",
  "portal",
  "database",
  "platform",
  "software",
  "api",
  "server",
  "application system",
  // German
  "datenbank", "plattform", "anwendung",
];

const DATA_HINTS = [
  "document",
  "documents",
  "invoice",
  "form",
  "report",
  "permit",
  "contract",
  "application",
  "request",
  "order",
  "ticket",
  "file",
  "record",
  "certificate",
  "quote",
  "offer",
  "specification",
  "drawing",
  "plan",
  "purchase order",
  // German
  "dokument", "dokumente", "unterlagen", "rechnung", "formular", "bericht",
  "genehmigung", "vertrag", "antrag", "anforderung", "bestellanforderung",
  "bestellung", "auftrag", "datei", "datensatz", "zertifikat", "angebot",
  "lieferschein", "nachweis", "beleg",
];

const DECISION_RE = /\b(if|whether|decide|depending on|in case|check\w* (?:if|whether)|falls|ob|wenn|sofern|je nachdem|entscheid\w*|prüf\w* ob)\b/i;
const APPROVAL_RE = /\b(approv\w*|sign[- ]?off|authoriz\w*|reject\w*|freigab\w*|freigeb\w*|freigegeben|freigib\w*|frei|genehmig\w*|bewillig\w*|ablehn\w*|abgelehnt|unterschreib\w*|unterzeichn\w*)\b/i;
const CHECK_RE = /\b(check\w*|verif\w*|review\w*|validat\w*|inspect\w*|control\w*|examin\w*|assess\w*|prüf\w*|überprüf\w*|kontrollier\w*|verifizier\w*|validier\w*|begutacht\w*|bewert\w*|sicht\w*)\b/i;
const EXCEPTION_RE = /\b(missing|incomplete|invalid|error|fail\w*|escalat\w*|exception|reject\w*|not (?:complete|valid|approved)|fehlt|fehlend\w*|unvollständig\w*|ungültig\w*|fehler\w*|scheiter\w*|eskalier\w*|ausnahme|abgelehnt)\b/i;
const LOOP_RE = /\b(send back|sent back|return\w* to|resubmit|rework|request\w* again|back to|until|loop|zurück\w*|erneut|nacharbeit\w*|wiederhol\w*|bis|schleife)\b/i;
const START_RE = /\b(start\w*|begin\w*|upon|when .* (?:received|submitted|arrives)|triggered by|initiat\w*|beginnt|startet|sobald|wenn .* (?:eingeht|eingegangen|eintrifft|empfangen|gestartet|gestellt)|bei eingang|ausgelöst)\b/i;
const END_RE = /\b(end\b|ends\b|finish\w*|complete\w*|archiv\w*|closed?|done|terminat\w*|endet|abgeschlossen|fertig|beendet|geschlossen)\b/i;

let stepCounter = 0;
function nextId(): string {
  stepCounter += 1;
  return `s${stepCounter}`;
}
export function resetStepCounter(): void {
  stepCounter = 0;
}

/** Segment raw input into ordered textual units. */
export function segment(input: string): Array<{ text: string; role?: string }> {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const units: Array<{ text: string; role?: string }> = [];
  const pushSentences = (text: string, role?: string) => {
    // strip list markers
    let t = text.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "");
    t = t.replace(/^\s*step\s*\d+\s*[:.-]\s*/i, "");
    // split prose into clauses on sentence enders and strong connectors
    const clauses = t
      .split(/(?<=[.;])\s+|\.\s+|,?\s+then\s+|,?\s+and then\s+|,?\s+dann\s+|,?\s+und dann\s+|,?\s+danach\s+/i)
      .map((c) => c.trim().replace(/[.;]+$/, ""))
      .filter((c) => c.length > 2);
    for (const c of clauses) units.push({ text: c, role });
  };

  if (lines.length > 1) {
    for (const line of lines) {
      // "Role: action" prefix
      const m = line.match(/^([A-Z][\w \/-]{2,30}?):\s*(.+)$/);
      if (m && ROLE_HINTS.some((r) => m[1].toLowerCase().includes(r))) {
        pushSentences(m[2], normalizeRole(m[1]));
      } else {
        pushSentences(line);
      }
    }
  } else {
    pushSentences(lines[0] ?? input);
  }
  return units;
}

function normalizeRole(s: string): string {
  return cleanRole(s);
}

/** Strip leading articles and surrounding noise, then title-case. */
function cleanRole(s: string): string {
  let t = s.trim();
  // remove leading articles repeatedly (der/die/das/den/dem/ein…, the/a/an)
  for (;;) {
    const next = t.replace(/^(?:der|die|das|den|dem|des|ein|eine|einen|einem|the|a|an)\s+/i, "");
    if (next === t) break;
    t = next;
  }
  return capitalize(t.trim());
}

function detectRole(text: string, fallback?: string): string | undefined {
  const lower = text.toLowerCase();
  // "by the X" / "durch den X" / "vom X" / "von der X"
  const by = lower.match(/(?:by|durch|vom|von) (?:the |a |dem |der |den |das )?([\wäöüß ]+?)(?:\.|,|;|$| if | when | and | wenn | und )/);
  if (by) {
    const cand = by[1].trim();
    const hit = ROLE_HINTS.find((r) => cand.includes(r));
    if (hit) return cleanRole(extractRolePhrase(cand, hit));
  }
  // "the X verb" / "der X verb" with EN+DE verb stems
  for (const r of ROLE_HINTS) {
    const re = new RegExp(
      `(?:the |a |der |die |das |dem |den )?([\\wäöüß]*${r}[\\wäöüß]*) (?:approv|review|check|verif|process|prepar|sign|handl|creat|send|receiv|complet|prüf|gibt|genehmig|kontrollier|erfass|erstell|sende|bearbeit|leg|nimm|überprüf|freigeb|freigib)`,
      "i",
    );
    const m = lower.match(re);
    if (m) return cleanRole(m[1].trim());
  }
  // Language-agnostic fallback: any role hint present in the clause.
  for (const r of ROLE_HINTS) {
    const idx = lower.indexOf(r);
    if (idx >= 0) {
      const phrase = lower.slice(Math.max(0, idx - 14), idx + r.length);
      return cleanRole(extractRolePhrase(phrase.trim(), r));
    }
  }
  return fallback;
}

function extractRolePhrase(phrase: string, hint: string): string {
  // keep up to two words around the hint
  const words = phrase.split(/\s+/);
  const idx = words.findIndex((w) => w.includes(hint));
  if (idx < 0) return hint;
  const start = Math.max(0, idx - 1);
  return words.slice(start, idx + 1).join(" ");
}

function detectSystem(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const s of SYSTEM_HINTS) {
    if (new RegExp(`\\b${s}\\b`).test(lower)) {
      if (s === "system") return "System";
      return s.toUpperCase().length <= 4 ? s.toUpperCase() : capitalize(s);
    }
  }
  // standalone uppercase acronym (SAP, CRM)
  const acro = text.match(/\b([A-Z]{2,5})\b/);
  if (acro && !["BPMN", "XOR", "AND", "OR"].includes(acro[1])) return acro[1];
  return undefined;
}

function detectData(text: string, acc: Set<string>): void {
  const lower = text.toLowerCase();
  for (const d of DATA_HINTS) {
    if (new RegExp(`\\b${d}\\b`).test(lower)) acc.add(capitalize(singular(d)));
  }
}

function singular(w: string): string {
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function classify(text: string, isFirst: boolean, isLast: boolean): StepKind {
  // Boundary sentences win first so a German "Wenn … eingeht" opener is a start
  // event rather than a decision.
  if (isFirst && START_RE.test(text)) return "start";
  if (isLast && END_RE.test(text) && !APPROVAL_RE.test(text) && !DECISION_RE.test(text)) return "end";
  if (DECISION_RE.test(text) && !APPROVAL_RE.test(text)) return "decision";
  if (APPROVAL_RE.test(text)) return "approval";
  if (CHECK_RE.test(text)) return "check";
  if (isLast && END_RE.test(text)) return "end";
  if (EXCEPTION_RE.test(text)) return "exception";
  return "task";
}

/** Produce a readable object+verb name from a clause. */
export function normalizeName(text: string, kind: StepKind): string {
  let t = text.replace(/^(?:the |a |an |der |die |das |dem |den |ein |eine |einen )/i, "").trim();
  // drop trailing role attribution (EN + DE)
  t = t.replace(/\b(?:by|durch|vom|von) (?:the |a |dem |der |den )?[\wäöüß ]+$/i, "").trim();
  t = t.replace(/^(?:then|next|after that|afterwards|dann|danach|anschließend|zuerst)\s+/i, "");
  if (kind === "decision" || kind === "approval") {
    // phrase as a question
    const cond = extractCondition(t);
    if (cond) return capitalizeFirst(cond) + "?";
  }
  // Capitalize verb, keep concise (max ~6 words)
  const words = t.split(/\s+/).slice(0, 7);
  return capitalizeFirst(words.join(" "));
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractCondition(text: string): string | undefined {
  const m = text.match(/\b(?:if|whether|check if|check whether|in case|wenn|falls|ob|sofern)\b\s+(.+)/i);
  if (m) {
    return m[1].split(/,| then | otherwise | else | dann | sonst | andernfalls /i)[0].trim();
  }
  if (APPROVAL_RE.test(text)) return "approved";
  return undefined;
}

/** Build branches for a decision / approval step. */
function buildBranches(_text: string, kind: StepKind, hasException: boolean): BranchIR[] {
  if (kind === "approval") {
    const branches: BranchIR[] = [
      { condition: "approved", steps: [] },
      { condition: "rejected", steps: [], isDefault: false },
    ];
    return branches;
  }
  // decision: try to split "if X ... otherwise Y"
  const yes = "yes";
  const no = "no";
  void hasException;
  return [
    { condition: yes, steps: [] },
    { condition: no, steps: [], isDefault: true },
  ];
}

/** Lightweight language detector for localizing synthesized labels. */
function detectLang(input: string): "de" | "en" {
  const t = input.toLowerCase();
  const deMarkers = /\b(der|die|das|und|wenn|wird|den|eine|einen|prüf|sendet|erstellt|nicht|durch|vom|von|abteilungsleiter|sachbearbeiter|antrag|rechnung|bestellung|genehmig|freigab|freigeb|unvollständig|zurück)\b|[äöüß]/;
  return deMarkers.test(t) ? "de" : "en";
}

export function extractIR(input: string): ProcessIR {
  resetStepCounter();
  const lang = detectLang(input);
  const units = segment(input);
  const roles = new Set<string>();
  const systems = new Set<string>();
  const dataObjects = new Set<string>();
  const assumptions: string[] = [];
  const ambiguities: Ambiguity[] = [];
  const steps: StepIR[] = [];

  units.forEach((u, i) => {
    const isFirst = i === 0;
    const isLast = i === units.length - 1;
    const kind = classify(u.text, isFirst, isLast);
    const role = u.role ?? detectRole(u.text);
    const system = detectSystem(u.text);
    if (role) roles.add(role);
    if (system) systems.add(system);
    detectData(u.text, dataObjects);

    const step: StepIR = {
      id: nextId(),
      kind,
      text: u.text,
      name: normalizeName(u.text, kind),
      role,
      system,
      provenance: u.text,
    };
    if (kind === "decision" || kind === "approval") {
      step.branches = buildBranches(u.text, kind, EXCEPTION_RE.test(u.text));
    }
    steps.push(step);
  });

  const de = lang === "de";
  // Ensure explicit start/end.
  if (!steps.some((s) => s.kind === "start")) {
    steps.unshift({
      id: nextId(),
      kind: "start",
      text: "Process start",
      name: deriveStartName(input, lang),
      provenance: de ? "(impliziter Start)" : "(implicit start)",
    });
    assumptions.push(de ? "Kein expliziter Auslöser genannt; generisches Startereignis ergänzt." : "No explicit trigger was stated; added a generic start event.");
  }
  if (!steps.some((s) => s.kind === "end")) {
    steps.push({
      id: nextId(),
      kind: "end",
      text: "Process end",
      name: de ? "Prozess abgeschlossen" : "Process completed",
      provenance: de ? "(implizites Ende)" : "(implicit end)",
    });
    assumptions.push(de ? "Kein explizites Ende genannt; generisches Endereignis ergänzt." : "No explicit end was stated; added a generic end event.");
  }

  // Loop / rework detection: an exception or rejected branch returns to an
  // earlier task. Wire loopTo to the most recent check/task before it.
  wireLoops(steps, assumptions, lang);

  // Ambiguities
  if (roles.size === 0) {
    ambiguities.push(
      de
        ? { about: "Verantwortlichkeit", question: "Keine eindeutigen Rollen erkannt. Wer führt diese Schritte aus?", options: ["Eine gemeinsame Bahn für das Team", "Rollen offen lassen"] }
        : { about: "responsibility", question: "No clear roles were detected. Who performs these steps?", options: ["Add a single lane for the whole team", "Leave roles unassigned"] },
    );
  }
  const decisionsWithoutConditions = steps.filter(
    (s) => s.kind === "decision" && (!s.branches || s.branches.every((b) => /^(yes|no)$/.test(b.condition))),
  );
  for (const d of decisionsWithoutConditions) {
    ambiguities.push(
      de
        ? { about: `Entscheidung „${d.name}“`, question: `Wie lauten die genauen Ergebnisse von „${d.name}“? Standardmäßig ja/nein.` }
        : { about: `decision "${d.name}"`, question: `What are the exact outcomes of "${d.name}"? Defaulted to yes/no.` },
    );
  }

  return {
    title: deriveTitle(input),
    lang,
    roles: [...roles],
    systems: [...systems],
    dataObjects: [...dataObjects],
    steps,
    assumptions,
    ambiguities,
  };
}

function deriveTitle(input: string): string {
  let first = input.trim().split(/\r?\n/)[0];
  // drop a leading conditional clause ("Wenn …, " / "When …, ")
  if (/^(wenn|when|falls|sobald|als)\b/i.test(first) && first.includes(",")) {
    first = first.slice(first.indexOf(",") + 1);
  }
  first = first.replace(/[.:,].*$/, "").trim();
  // strip leading articles/connectors
  first = first.replace(/^(?:der|die|das|den|dem|ein|eine|the|a|an|so|also|im grunde)\s+/i, "");
  const words = first.split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  return capitalize(words) || (/[äöüß]|\b(der|die|das|und)\b/i.test(input) ? "Prozess" : "Process");
}

function deriveStartName(input: string, lang: "de" | "en"): string {
  if (lang === "de") {
    if (/rechnung/i.test(input)) return "Rechnung eingegangen";
    if (/anforderung|antrag/i.test(input)) return "Anforderung eingegangen";
    if (/bestellung|auftrag/i.test(input)) return "Bestellung eingegangen";
    return "Prozess gestartet";
  }
  if (/invoice/i.test(input)) return "Invoice received";
  if (/request/i.test(input)) return "Request received";
  if (/application/i.test(input)) return "Application received";
  if (/order/i.test(input)) return "Order received";
  return "Process started";
}

function wireLoops(steps: StepIR[], assumptions: string[], lang: "de" | "en"): void {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const loopText = LOOP_RE.test(s.text) || EXCEPTION_RE.test(s.text);
    if (!loopText) continue;
    // find a preceding task/check to loop back to
    let target: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (steps[j].kind === "task" || steps[j].kind === "check") {
        target = steps[j].id;
        break;
      }
    }
    if (!target) continue;
    if (s.kind === "approval" || s.kind === "decision") {
      const rejected = s.branches?.find((b) => /reject|no/.test(b.condition));
      if (rejected) {
        rejected.loopTo = target;
        const targetName = steps.find((x) => x.id === target)?.name;
        assumptions.push(
          lang === "de"
            ? `Nachbearbeitungsschleife modelliert: „${s.name}“ kehrt bei Misserfolg zu „${targetName}“ zurück.`
            : `Modeled a rework loop: "${s.name}" returns to "${targetName}" when not successful.`,
        );
      }
    }
  }
}
