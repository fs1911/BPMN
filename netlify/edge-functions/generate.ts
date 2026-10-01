import Anthropic from "@anthropic-ai/sdk";
import { GRAPH_EDIT_PROMPT, GRAPH_IR_SCHEMA, GRAPH_SYSTEM_PROMPT, MAX_TEXT_CHARS } from "../../src/core/ai/graph-schema.ts";

/**
 * Server-side LLM endpoint, NDJSON stream:
 *   POST /api/generate  { text }                                   → new process
 *   POST /api/generate  { mode: "edit", graph, instruction }       → edited process
 *
 * Runs as a Netlify *edge* function because generation with thinking can take
 * well over the 10 s limit of regular functions; edge functions only need to
 * start responding quickly and may then stream for as long as needed. The
 * endpoint is deliberately narrow — model, prompt and output schema are fixed
 * here — so the API key cannot be used as a general-purpose proxy.
 *
 * Events (one JSON object per line):
 *   {"type":"progress","phase":"thinking"|"writing","chars"?:n}
 *   {"type":"result","graph":{…GraphIR…}}
 *   {"type":"error","code":"no_key"|"bad_input"|"refusal"|"too_long"|"api","message":"…"}
 */

declare const Netlify: { env: { get(key: string): string | undefined } };

const MODEL = "claude-opus-5";
const MAX_INPUT_CHARS = MAX_TEXT_CHARS;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_GRAPH_CHARS = 120_000;

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let text = "";
  let edit: { instruction: string; graph: string } | undefined;
  try {
    const body = (await req.json()) as { text?: unknown; mode?: unknown; instruction?: unknown; graph?: unknown };
    if (body.mode === "edit") {
      edit = { instruction: String(body.instruction ?? "").trim(), graph: JSON.stringify(body.graph ?? null) };
    } else {
      text = String(body.text ?? "").trim();
    }
  } catch {
    /* handled below */
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (ev: Record<string, unknown>) => controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      const fail = (code: string, message: string) => {
        send({ type: "error", code, message });
        controller.close();
      };

      const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) return fail("no_key", "Auf dem Server ist kein ANTHROPIC_API_KEY hinterlegt.");
      let system: string;
      let content: string;
      if (edit) {
        if (!edit.instruction) return fail("bad_input", "Bitte eine Änderungsanweisung eingeben.");
        if (edit.instruction.length > MAX_INSTRUCTION_CHARS) {
          return fail("bad_input", `Anweisung zu lang (maximal ${MAX_INSTRUCTION_CHARS} Zeichen).`);
        }
        if (edit.graph === "null" || edit.graph.length > MAX_GRAPH_CHARS) {
          return fail("bad_input", "Das aktuelle Diagramm fehlt oder ist zu groß für eine KI-Änderung.");
        }
        system = GRAPH_EDIT_PROMPT;
        content = `<current_process>\n${edit.graph}\n</current_process>\n<instruction>\n${edit.instruction}\n</instruction>`;
      } else {
        if (!text) return fail("bad_input", "Bitte einen Prozesstext eingeben.");
        if (text.length > MAX_INPUT_CHARS) {
          return fail("bad_input", `Text zu lang (${text.length} Zeichen, maximal ${MAX_INPUT_CHARS}).`);
        }
        system = GRAPH_SYSTEM_PROMPT;
        content = `<process_description>\n${text}\n</process_description>`;
      }

      let phase: "thinking" | "writing" = "thinking";
      let chars = 0;
      send({ type: "progress", phase });
      // Keep the connection visibly alive while the model is thinking (no bytes flow then).
      const heartbeat = setInterval(() => send({ type: "progress", phase, chars }), 5000);

      try {
        const client = new Anthropic({ apiKey });
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: GRAPH_IR_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        });

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            chars += event.delta.text.length;
            if (phase !== "writing") {
              phase = "writing";
              send({ type: "progress", phase, chars });
            }
          }
        }
        const message = await stream.finalMessage();

        if (message.stop_reason === "refusal") return fail("refusal", "Die KI hat die Anfrage abgelehnt.");
        if (message.stop_reason === "max_tokens") return fail("too_long", "Die KI-Antwort wurde abgeschnitten (Prozess zu groß).");

        const json = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        let graph: unknown;
        try {
          graph = JSON.parse(json);
        } catch {
          return fail("api", "Die KI-Antwort war kein gültiges JSON.");
        }
        send({ type: "result", graph });
        controller.close();
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) fail("api", "Der hinterlegte API-Schlüssel ist ungültig.");
        else if (err instanceof Anthropic.RateLimitError) fail("api", "KI-Dienst ist ausgelastet – bitte gleich noch einmal versuchen.");
        else if (err instanceof Anthropic.APIError) fail("api", `KI-Dienst meldet Fehler ${err.status ?? ""}: ${err.message}`);
        else fail("api", `KI-Aufruf fehlgeschlagen: ${(err as Error).message}`);
      } finally {
        clearInterval(heartbeat);
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/generate" };
