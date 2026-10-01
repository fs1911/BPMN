import { BpmnModel } from "../model";
import { extractIR } from "./extract";
import { applyInstruction, InstructionResult } from "./instructions";
import { MappingResult, mapIrToModel } from "./map";
import { assessModel } from "./quality";
import { ProcessIR, ReviewReport } from "./types";

export * from "./types";
export { extractIR } from "./extract";
export { applyInstruction } from "./instructions";
export type { InstructionResult } from "./instructions";
export { assessModel } from "./quality";
export type { QualityAssessment } from "./quality";
export {
  GRAPH_IR_SCHEMA,
  GRAPH_SYSTEM_PROMPT,
  mapGraphToModel,
  sanitizeGraphIR,
} from "./graph";
export type { GraphIR, GraphNodeIR, GraphFlowIR } from "./graph";
export { editViaLlm, generateViaLlm, LlmUnavailableError } from "./remote";
export type { EditResult, LlmCallOptions, LlmProgress, GenerationResultGraph } from "./remote";
export { applyEditedGraph, diffGraphs, modelToGraphIR } from "./edit";
export { MAX_TEXT_CHARS } from "./graph-schema";
export type { GraphDiff } from "./edit";

export interface GenerationResult {
  model: BpmnModel;
  ir: ProcessIR;
  review: ReviewReport;
}

/**
 * Text → BPMN with the deterministic, offline rule-based extractor. Its
 * confidence is capped by a model-level quality assessment, so mangled output
 * (sentence fragments as task names, missing branches) is flagged instead of
 * being reported as trustworthy.
 */
export function generateFromTextSync(input: string): GenerationResult {
  const ir = extractIR(input);
  const { model, review }: MappingResult = mapIrToModel(ir);
  const quality = assessModel(model, { sourceText: input, ambiguities: ir.ambiguities.length });
  review.confidence = Math.min(review.confidence, quality.confidence);
  review.findings = quality.findings;
  review.source = "rules";
  return { model, ir, review };
}

/** Instruction → model update (re-validated, re-laid-out in place). */
export function updateByInstruction(model: BpmnModel, instruction: string): InstructionResult {
  return applyInstruction(model, instruction);
}
