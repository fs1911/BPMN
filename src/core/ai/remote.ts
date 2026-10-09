import type { BpmnModel } from "../model";
import { GraphIR, mapGraphToModel, sanitizeGraphIR } from "./graph";
import { GraphDiff, applyEditedGraph, diffGraphs, modelToGraphIR } from "./edit";
import type { ReviewReport } from "./types";
import { readClaudeStream } from "./stream";
import { buildCorrectionInstruction, normViolations } from "./correct";

export interface GenerationResultGraph {
  model: BpmnModel;
  ir: GraphIR;
  review: ReviewReport;
}

/**
 * Client for the server-side LLM endpoint (`server/llm.ts`, run as Cloudflare
 * Worker or Netlify edge function).
 *
 * The API key never reaches the browser: the server holds it, fixes the
 * model/prompt/schema, and passes Claude's event stream back. The browser only sends
 * the process text and receives a Graph IR, which is sanitized and mapped
 * locally — the LLM never writes BPMN or touches the canvas directly.
 */

export interface LlmProgress {
  phase: "thinking" | "writing" | "correcting";
  /** characters of JSON received so far (writing phase). */
  chars?: number;
  /** violations of the standard being sent back (correcting phase). */
  violations?: number;
}

/** The endpoint is not there (local `vite dev`, no key configured, …). */
export class LlmUnavailableError extends Error {}

export interface LlmCallOptions {
  endpoint?: string;
  onProgress?: (p: LlmProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface GenerateOptions extends LlmCallOptions {
  /** send violations of the standard back to the AI once (a second, paid call) */
  selfCorrect?: boolean;
}

/** Text → new diagram. */
export async function generateViaLlm(text: string, opts: GenerateOptions = {}): Promise<GenerationResultGraph> {
  const graph = await callEndpoint({ text }, opts);
  const { ir, repairs } = sanitizeGraphIR(graph);
  if (!ir.nodes.length) throw new Error("Die KI hat keinen Prozess erkannt.");
  const { model, review } = mapGraphToModel(ir, { sourceText: text, repairs });
  const first = { model, ir, review };
  return opts.selfCorrect ? selfCorrect(first, opts) : first;
}

/**
 * One correction round: the AI gets the violations as an edit instruction.
 * The corrected diagram is kept only if it has fewer violations; either way
 * the review says what happened.
 */
async function selfCorrect(first: GenerationResultGraph, opts: LlmCallOptions): Promise<GenerationResultGraph> {
  const before = normViolations(first.model);
  if (!before.length) return first;
  const note = (text: string): GenerationResultGraph => ({ ...first, review: { ...first.review, findings: [text, ...(first.review.findings ?? [])] } });
  opts.onProgress?.({ phase: "correcting", violations: before.length });
  let fixed: EditResult;
  try {
    fixed = await editViaLlm(first.model, buildCorrectionInstruction(first.model, before), opts);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return note(`Selbstkorrektur fehlgeschlagen (${(err as Error).message}) – ${before.length} Normverstoss/-verstösse bleiben, siehe Diagramm-Prüfung.`);
  }
  const after = normViolations(fixed.model);
  if (after.length >= before.length) {
    return note(`Selbstkorrektur ohne Verbesserung – ${before.length} Normverstoss/-verstösse bleiben, siehe Diagramm-Prüfung.`);
  }
  const fixedCount = before.length - after.length;
  return {
    model: fixed.model,
    ir: fixed.ir,
    review: {
      ...fixed.review,
      // the edit only describes its own change: keep what the generation said
      assumptions: [...first.review.assumptions, ...fixed.review.assumptions],
      ambiguities: [...first.review.ambiguities, ...fixed.review.ambiguities],
      confidence: first.review.confidence,
      findings: [
        `Selbstkorrektur: ${fixedCount} von ${before.length} Normverstoss/-verstössen behoben (${fixed.diff.summary.replace(/\.$/, "")}).` +
          (after.length ? ` ${after.length} bleiben, siehe Diagramm-Prüfung.` : ""),
        ...(fixed.review.findings ?? []),
      ],
    },
  };
}

export interface EditResult extends GenerationResultGraph {
  diff: GraphDiff;
}

/** Existing diagram + instruction → edited diagram (ids and arrangement kept). */
export async function editViaLlm(current: BpmnModel, instruction: string, opts: LlmCallOptions = {}): Promise<EditResult> {
  const before = modelToGraphIR(current);
  const graph = await callEndpoint({ mode: "edit", instruction, graph: before }, opts);
  const { ir, repairs } = sanitizeGraphIR(graph);
  if (!ir.nodes.length) throw new Error("Die KI hat ein leeres Diagramm geliefert – Änderung verworfen.");
  const { model, review } = applyEditedGraph(current, ir, { repairs, instruction });
  return { model, ir, review, diff: diffGraphs(before, ir) };
}

/** POST to the AI endpoint and read Claude's event stream until the result. */
async function callEndpoint(payload: Record<string, unknown>, opts: LlmCallOptions): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(opts.endpoint ?? "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new LlmUnavailableError("KI-Dienst nicht erreichbar.");
  }
  const ctype = resp.headers.get("content-type") ?? "";
  if (ctype.includes("application/json") && !resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { code?: string; message?: string; error?: string };
    // The access gate answers {error: "login_required"}: the login expired or was revoked.
    if (err.error === "login_required") throw new LlmUnavailableError(`Anmeldung abgelaufen (HTTP ${resp.status}) – Seite neu laden und Zugangscode eingeben.`);
    if (err.code === "no_key") throw new LlmUnavailableError(err.message ?? "Kein API-Schlüssel hinterlegt.");
    throw new Error(err.message ?? `KI-Dienst meldet Fehler (HTTP ${resp.status}).`);
  }
  if (!ctype.includes("text/event-stream")) {
    if (resp.status === 401 || resp.status === 403) {
      throw new LlmUnavailableError(`Anmeldung abgelaufen (HTTP ${resp.status}) – Seite neu laden und Zugangscode eingeben.`);
    }
    throw new LlmUnavailableError(`KI-Dienst nicht verfügbar (HTTP ${resp.status}).`);
  }
  if (!resp.body) throw new LlmUnavailableError("KI-Dienst lieferte keine Antwort.");

  const { text } = await readClaudeStream(resp.body, opts.onProgress);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Die KI-Antwort war kein gültiges JSON.");
  }
}
