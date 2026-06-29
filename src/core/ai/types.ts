/**
 * Intermediate Process Representation (IR).
 *
 * The AI layer never writes to the canvas directly. Natural language is first
 * turned into this structured, reviewable IR; the IR is normalized and then
 * deterministically mapped to a BpmnModel. This keeps generation auditable
 * (every element traces back to source text) and lets us surface assumptions
 * and ambiguities before anything touches the diagram.
 */

export type StepKind =
  | "start"
  | "end"
  | "task"
  | "decision"
  | "approval"
  | "check"
  | "event"
  | "exception";

export interface BranchIR {
  /** human-readable answer/condition, e.g. "approved" / "rejected". */
  condition: string;
  /** ids of steps that belong to this branch (in order). */
  steps: string[];
  /** if the branch loops back, the target step id. */
  loopTo?: string;
  /** if the branch ends the process. */
  ends?: boolean;
  isDefault?: boolean;
}

export interface StepIR {
  id: string;
  kind: StepKind;
  text: string;
  /** normalized, readable element name (object + verb). */
  name: string;
  role?: string;
  system?: string;
  /** for decision/approval steps. */
  branches?: BranchIR[];
  /** event definition hint for event steps. */
  event?: "message" | "timer" | "error" | "none";
  /** source sentence/line for provenance. */
  provenance: string;
}

export interface Ambiguity {
  about: string;
  question: string;
  /** optional modeling alternatives offered to the user. */
  options?: string[];
}

export interface ProcessIR {
  title?: string;
  roles: string[];
  systems: string[];
  dataObjects: string[];
  steps: StepIR[];
  assumptions: string[];
  ambiguities: Ambiguity[];
}

export interface ReviewReport {
  roles: string[];
  systems: string[];
  dataObjects: string[];
  decisions: string[];
  loops: string[];
  exceptions: string[];
  approvals: string[];
  checks: string[];
  assumptions: string[];
  ambiguities: Ambiguity[];
  /** element id -> source text that produced it. */
  provenance: Record<string, string>;
  confidence: number; // 0..1
}
