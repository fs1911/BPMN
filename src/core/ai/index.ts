import { BpmnModel } from "../model";
import { extractIR } from "./extract";
import { applyInstruction, InstructionResult } from "./instructions";
import { LlmExtractor } from "./llm";
import { MappingResult, mapIrToModel } from "./map";
import { ProcessIR, ReviewReport } from "./types";

export * from "./types";
export { extractIR } from "./extract";
export { applyInstruction } from "./instructions";
export type { InstructionResult } from "./instructions";
export { createAnthropicExtractor } from "./llm";
export type { LlmExtractor, AnthropicConfig } from "./llm";

export interface GenerationResult {
  model: BpmnModel;
  ir: ProcessIR;
  review: ReviewReport;
}

/**
 * Text → BPMN. Runs the full pipeline: extract IR (deterministic by default,
 * or via an injected LLM extractor), map to BPMN, validate, layout, route, and
 * produce a review report. The returned model is an editable diagram.
 */
export async function generateFromText(
  input: string,
  opts?: { extractor?: LlmExtractor },
): Promise<GenerationResult> {
  const ir = opts?.extractor ? await opts.extractor.extract(input) : extractIR(input);
  const { model, review }: MappingResult = mapIrToModel(ir);
  return { model, ir, review };
}

/** Synchronous text → BPMN using the deterministic extractor. */
export function generateFromTextSync(input: string): GenerationResult {
  const ir = extractIR(input);
  const { model, review } = mapIrToModel(ir);
  return { model, ir, review };
}

/** Instruction → model update (re-validated, re-laid-out in place). */
export function updateByInstruction(model: BpmnModel, instruction: string): InstructionResult {
  return applyInstruction(model, instruction);
}
