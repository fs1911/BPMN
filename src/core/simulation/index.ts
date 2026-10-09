import type { BpmnModel } from "../model";
import type { ValidationIssue } from "../validation/validator";
import { analyzeSoundness } from "./soundness";

export { analyzeSoundness } from "./soundness";
export type { FlowIssue, FlowIssueKind, SoundnessResult } from "./soundness";

/** Simulation findings in the shape of the validation panel. */
export function simulationIssues(model: BpmnModel): ValidationIssue[] {
  const r = analyzeSoundness(model);
  const issues: ValidationIssue[] = r.issues.map((i) => ({
    rule: `simulation.${i.kind}`,
    severity: i.severity,
    message: i.message,
    hint: i.hint,
    elementId: i.elementIds[0],
    relatedIds: i.elementIds.slice(1),
    trace: i.trace.length ? i.trace : undefined,
  }));
  if (r.truncated) {
    issues.push({
      rule: "simulation.incomplete",
      severity: "info",
      message: `Ablaufprüfung nach ${r.states} Zuständen abgebrochen – der Prozess hat sehr viele parallele Kombinationen; nicht alle Abläufe wurden durchgespielt.`,
    });
  }
  return issues;
}
