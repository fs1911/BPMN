import Anthropic from "@anthropic-ai/sdk";
import {
  GRAPH_EDIT_PROMPT,
  GRAPH_IR_SCHEMA,
  GRAPH_SYSTEM_PROMPT,
  MAX_INSTRUCTION_CHARS,
  MAX_TEXT_CHARS,
} from "../src/core/ai/graph-schema.ts";

/**
 * Server side of the AI endpoint, shared by the Cloudflare Worker and the
 * Netlify edge function:
 *
 *   POST /api/generate  { text }                                → new process
 *   POST /api/generate  { mode: "edit", graph, instruction }    → edited process
 *
 * The server validates the input, fixes model, prompt and output schema (so
 * the API key cannot be used as a general-purpose proxy) and passes Claude's
 * event stream through unparsed. Parsing happens in the browser: on
 * Cloudflare's free plan a request may use only ~10 ms of CPU, and reading a
 * long stream event by event on the server could exceed that, while piping
 * bytes costs almost nothing.
 *
 * Responses:
 *   200 text/event-stream       Claude's SSE stream (see src/core/ai/stream.ts)
 *   4xx/5xx application/json    { code: "no_key"|"bad_input"|"api", message }
 */

export const MODEL = "claude-opus-5";
const MAX_GRAPH_CHARS = 120_000;

export interface LlmServerEnv {
  apiKey?: string;
  /** tests only: point the SDK at a local mock of the API */
  baseURL?: string;
}

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function handleGenerate(req: Request, env: LlmServerEnv): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: { text?: unknown; mode?: unknown; instruction?: unknown; graph?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → bad_input below */
  }

  let system: string;
  let content: string;
  if (body.mode === "edit") {
    const instruction = String(body.instruction ?? "").trim();
    const graph = JSON.stringify(body.graph ?? null);
    if (!instruction) return json(400, "bad_input", "Bitte eine Änderungsanweisung eingeben.");
    if (instruction.length > MAX_INSTRUCTION_CHARS) return json(400, "bad_input", `Anweisung zu lang (maximal ${MAX_INSTRUCTION_CHARS} Zeichen).`);
    if (graph === "null" || graph.length > MAX_GRAPH_CHARS) return json(400, "bad_input", "Das aktuelle Diagramm fehlt oder ist zu groß für eine KI-Änderung.");
    system = GRAPH_EDIT_PROMPT;
    content = `<current_process>\n${graph}\n</current_process>\n<instruction>\n${instruction}\n</instruction>`;
  } else {
    const text = String(body.text ?? "").trim();
    if (!text) return json(400, "bad_input", "Bitte einen Prozesstext eingeben.");
    if (text.length > MAX_TEXT_CHARS) return json(400, "bad_input", `Text zu lang (${text.length} Zeichen, maximal ${MAX_TEXT_CHARS}).`);
    system = GRAPH_SYSTEM_PROMPT;
    content = `<process_description>\n${text}\n</process_description>`;
  }

  if (!env.apiKey) return json(503, "no_key", "Auf dem Server ist kein ANTHROPIC_API_KEY hinterlegt.");

  try {
    const client = new Anthropic({ apiKey: env.apiKey, ...(env.baseURL ? { baseURL: env.baseURL } : {}) });
    // asResponse(): the raw HTTP response, body not read — HTTP errors still throw below.
    const upstream = await client.beta.messages
      .create({
        model: MODEL,
        max_tokens: 64000,
        stream: true,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: GRAPH_IR_SCHEMA } },
        system,
        messages: [{ role: "user", content }],
      })
      .asResponse();
    return new Response(upstream.body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return json(502, "api", "Der hinterlegte API-Schlüssel ist ungültig.");
    if (err instanceof Anthropic.RateLimitError) return json(429, "api", "KI-Dienst ist ausgelastet – bitte gleich noch einmal versuchen.");
    if (err instanceof Anthropic.APIError) return json(502, "api", `KI-Dienst meldet Fehler ${err.status ?? ""}: ${err.message}`);
    return json(502, "api", `KI-Aufruf fehlgeschlagen: ${(err as Error).message}`);
  }
}
