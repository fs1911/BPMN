import { BpmnModel } from "../model";
import { measureLayout } from "../layout/metrics";
import type { ValidationIssue } from "./validator";

/**
 * Drawing quality of the current diagram as validation issues, so defects that
 * appear through manual editing (dragging shapes) are visible immediately —
 * with the action that fixes them.
 */
export function layoutIssues(model: BpmnModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let m;
  try {
    m = measureLayout(model);
  } catch {
    return issues;
  }
  const fixFlows = "„Kanten aufräumen“ verlegt die Linien neu, ohne Elemente zu verschieben.";
  if (m.overlaps) {
    issues.push({ rule: "layout-overlap", style: true, severity: "warning", message: `An ${m.overlaps} Stelle(n) liegen Linien übereinander.`, hint: fixFlows });
  }
  if (m.shapeHits) {
    issues.push({ rule: "layout-shape-hit", style: true, severity: "warning", message: `${m.shapeHits} Linienabschnitt(e) laufen durch Elemente.`, hint: fixFlows });
  }
  if (m.outsidePool) {
    issues.push({ rule: "layout-outside", style: true, severity: "warning", message: "Linien verlaufen außerhalb des Pools.", hint: fixFlows });
  }
  if (m.nodeOverlaps) {
    issues.push({ rule: "layout-node-overlap", style: true, severity: "warning", message: `${m.nodeOverlaps} Element(e) überlappen sich.`, hint: "„Diagramm aufräumen“ ordnet alle Elemente neu an." });
  }
  if (m.diagonals) {
    issues.push({ rule: "layout-diagonal", style: true, severity: "info", message: `${m.diagonals} schräge Linienabschnitt(e).`, hint: fixFlows });
  }
  if (m.crossings) {
    issues.push({
      rule: "layout-crossing",
      style: true,
      severity: "info",
      message: `${m.crossings} Linienkreuzung(en).`,
      hint: "„Diagramm aufräumen“ ordnet so an, dass möglichst wenige Kreuzungen entstehen; manche sind durch die Prozessstruktur unvermeidbar.",
    });
  }
  return issues;
}
