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
];

const DECISION_RE = /\b(if|whether|decide|depending on|in case|check\w* (?:if|whether))\b/i;
const APPROVAL_RE = /\b(approv\w*|sign[- ]?off|authoriz\w*|reject\w*)\b/i;
const CHECK_RE = /\b(check\w*|verif\w*|review\w*|validat\w*|inspect\w*|control\w*|examin\w*|assess\w*)\b/i;
const EXCEPTION_RE = /\b(missing|incomplete|invalid|error|fail\w*|escalat\w*|exception|reject\w*|not (?:complete|valid|approved))\b/i;
const LOOP_RE = /\b(send back|sent back|return\w* to|resubmit|rework|request\w* again|back to|until|loop)\b/i;
const START_RE = /\b(start|begin|upon|when .* (?:received|submitted|arrives)|triggered by|initiat\w*)\b/i;
const END_RE = /\b(end|finish\w*|complete\w*|archiv\w*|closed?|done|terminat\w*)\b/i;

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
      .split(/(?<=[.;])\s+|\.\s+|,?\s+then\s+|,?\s+and then\s+/i)
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
  return s
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function detectRole(text: string, fallback?: string): string | undefined {
  const lower = text.toLowerCase();
  // "by the X" / "the X approves/reviews/..."
  const by = lower.match(/by (?:the |a )?([\w ]+?)(?:\.|,|;|$| if | when | and )/);
  if (by) {
    const cand = by[1].trim();
    const hit = ROLE_HINTS.find((r) => cand.includes(r));
    if (hit) return capitalize(extractRolePhrase(cand, hit));
  }
  for (const r of ROLE_HINTS) {
    const re = new RegExp(`(?:the |a )?([\\w ]*${r}[\\w ]*?) (?:approv|review|check|verif|process|prepar|sign|handl|creat|send|receiv|complet)`, "i");
    const m = lower.match(re);
    if (m) return capitalize(extractRolePhrase(m[1].trim(), r));
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
  if (DECISION_RE.test(text) && !APPROVAL_RE.test(text)) return "decision";
  if (APPROVAL_RE.test(text)) return "approval";
  if (CHECK_RE.test(text)) return "check";
  if (isFirst && START_RE.test(text)) return "start";
  if (isLast && END_RE.test(text)) return "end";
  if (EXCEPTION_RE.test(text)) return "exception";
  return "task";
}

/** Produce a readable object+verb name from a clause. */
export function normalizeName(text: string, kind: StepKind): string {
  let t = text.replace(/^(?:the |a |an )/i, "").trim();
  // drop trailing role attribution
  t = t.replace(/\bby (?:the |a )?[\w ]+$/i, "").trim();
  t = t.replace(/^(?:then|next|after that|afterwards)\s+/i, "");
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
  const m = text.match(/\b(?:if|whether|check if|check whether|in case)\b\s+(.+)/i);
  if (m) {
    return m[1].split(/,| then | otherwise | else /i)[0].trim();
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

export function extractIR(input: string): ProcessIR {
  resetStepCounter();
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

  // Ensure explicit start/end.
  if (!steps.some((s) => s.kind === "start")) {
    steps.unshift({
      id: nextId(),
      kind: "start",
      text: "Process start",
      name: deriveStartName(input),
      provenance: "(implicit start)",
    });
    assumptions.push("No explicit trigger was stated; added a generic start event.");
  }
  if (!steps.some((s) => s.kind === "end")) {
    steps.push({
      id: nextId(),
      kind: "end",
      text: "Process end",
      name: "Process completed",
      provenance: "(implicit end)",
    });
    assumptions.push("No explicit end was stated; added a generic end event.");
  }

  // Loop / rework detection: an exception or rejected branch returns to an
  // earlier task. Wire loopTo to the most recent check/task before it.
  wireLoops(steps, assumptions);

  // Ambiguities
  if (roles.size === 0) {
    ambiguities.push({
      about: "responsibility",
      question: "No clear roles were detected. Who performs these steps?",
      options: ["Add a single lane for the whole team", "Leave roles unassigned"],
    });
  }
  const decisionsWithoutConditions = steps.filter(
    (s) => s.kind === "decision" && (!s.branches || s.branches.every((b) => /^(yes|no)$/.test(b.condition))),
  );
  for (const d of decisionsWithoutConditions) {
    ambiguities.push({
      about: `decision "${d.name}"`,
      question: `What are the exact outcomes of "${d.name}"? Defaulted to yes/no.`,
    });
  }

  return {
    title: deriveTitle(input),
    roles: [...roles],
    systems: [...systems],
    dataObjects: [...dataObjects],
    steps,
    assumptions,
    ambiguities,
  };
}

function deriveTitle(input: string): string {
  const first = input.trim().split(/\r?\n/)[0].replace(/[.:].*$/, "");
  return capitalize(first.split(/\s+/).slice(0, 6).join(" ")) || "Generated Process";
}

function deriveStartName(input: string): string {
  if (/invoice/i.test(input)) return "Invoice received";
  if (/request/i.test(input)) return "Request received";
  if (/application/i.test(input)) return "Application received";
  if (/order/i.test(input)) return "Order received";
  return "Process started";
}

function wireLoops(steps: StepIR[], assumptions: string[]): void {
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
        assumptions.push(`Modeled a rework loop: "${s.name}" returns to "${steps.find((x) => x.id === target)?.name}" when not successful.`);
      }
    }
  }
}
