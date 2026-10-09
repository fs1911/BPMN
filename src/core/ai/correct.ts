import type { BpmnModel } from "../model";
import { validate, type ValidationIssue } from "../validation/validator";
import { simulationIssues } from "../simulation";
import { MAX_INSTRUCTION_CHARS } from "./graph-schema";

/**
 * Self-correction of AI results: violations of the standard (ISO/IEC 19510)
 * found by the checks are sent back to the AI once, as an edit instruction.
 * Only hard errors with a clause of the standard count — style hints and
 * layout remarks never trigger a second (paid) AI call.
 */

/** Errors that violate the standard: rule checks plus deadlocks / double runs of the simulation. */
export function normViolations(model: BpmnModel): ValidationIssue[] {
  return [...validate(model), ...simulationIssues(model)].filter((i) => i.severity === "error" && !!i.norm);
}

/** Edit instruction asking the AI to fix exactly these violations. */
export function buildCorrectionInstruction(model: BpmnModel, issues: ValidationIssue[]): string {
  const where = (id?: string) => {
    if (!id) return "";
    const n = model.nodes[id];
    if (n) return ` [Element ${id}${n.name ? ` „${n.name}“` : ""}]`;
    const e = model.edges[id];
    if (e) return ` [Fluss ${e.source} → ${e.target}]`;
    return "";
  };
  const head =
    "Das Diagramm verstösst gegen die BPMN-Norm ISO/IEC 19510. Korrigiere genau diese Punkte und ändere sonst nichts. " +
    "Bleibt ein Punkt ohne zusätzliche Information unlösbar, lass ihn unverändert und stelle dazu eine Rückfrage.\n";
  const lines: string[] = [];
  let length = head.length;
  for (const [k, i] of issues.entries()) {
    const line = `${k + 1}. ${i.message}${where(i.elementId)} (Norm ${i.norm})${i.hint ? ` – Lösungsweg: ${i.hint}` : ""}`;
    if (length + line.length + 1 > MAX_INSTRUCTION_CHARS - 80) {
      lines.push(`… und ${issues.length - k} weitere Punkte.`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return head + lines.join("\n");
}

/** Same problem (rule + place) — to compare before/after without counting reworded messages twice. */
export const issueKey = (i: ValidationIssue) => `${i.rule}@${i.elementId ?? ""}`;
