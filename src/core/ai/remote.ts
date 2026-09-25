import type { BpmnModel } from "../model";
import { GraphIR, mapGraphToModel, sanitizeGraphIR } from "./graph";
import { GraphDiff, applyEditedGraph, diffGraphs, modelToGraphIR } from "./edit";
import type { ReviewReport } from "./types";

export interface GenerationResultGraph {
  model: BpmnModel;
  ir: GraphIR;
  review: ReviewReport;
}

/**
 * Client for the server-side LLM endpoint (`netlify/edge-functions/generate.ts`).
 *
 * The API key never reaches the browser: the edge function holds it, fixes the
 * model/prompt/schema, and streams NDJSON events back. The browser only sends
 * the process text and receives a Graph IR, which is sanitized and mapped
 * locally — the LLM never writes BPMN or touches the canvas directly.
 */

export interface LlmProgress {
  phase: "thinking" | "writing";
  /** characters of JSON received so far (writing phase). */
  chars?: number;
}

/** The endpoint is not there (local `vite dev`, no key configured, …). */
export class LlmUnavailableError extends Error {}

export interface LlmCallOptions {
  endpoint?: string;
  onProgress?: (p: LlmProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Text → new diagram. */
export async function generateViaLlm(text: string, opts: LlmCallOptions = {}): Promise<GenerationResultGraph> {
  const graph = await callEndpoint({ text }, opts);
  const { ir, repairs } = sanitizeGraphIR(graph);
  if (!ir.nodes.length) throw new Error("Die KI hat keinen Prozess erkannt.");
  const { model, review } = mapGraphToModel(ir, { sourceText: text, repairs });
  return { model, ir, review };
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

/** POST to the edge function and read its NDJSON stream until the result. */
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
  if (!ctype.includes("application/x-ndjson")) {
    throw new LlmUnavailableError(`KI-Dienst nicht verfügbar (HTTP ${resp.status}).`);
  }
  if (!resp.body) throw new LlmUnavailableError("KI-Dienst lieferte keine Antwort.");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let graph: unknown;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as ServerEvent;
      if (ev.type === "progress") opts.onProgress?.({ phase: ev.phase, chars: ev.chars });
      else if (ev.type === "result") graph = ev.graph;
      else if (ev.type === "error") {
        if (ev.code === "no_key") throw new LlmUnavailableError(ev.message);
        throw new Error(ev.message);
      }
    }
    if (done) break;
  }
  if (graph === undefined) throw new Error("KI-Antwort unvollständig (Verbindung abgebrochen).");
  return graph;
}

type ServerEvent =
  | { type: "progress"; phase: "thinking" | "writing"; chars?: number }
  | { type: "result"; graph: unknown }
  | { type: "error"; code: string; message: string };
