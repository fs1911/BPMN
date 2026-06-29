import { ProcessIR } from "./types";

/**
 * Optional LLM-backed extractor. The pipeline works fully offline with the
 * deterministic extractor; when an Anthropic API key is available, this hook
 * can produce a richer IR. The LLM is constrained to emit IR JSON only — it
 * never writes BPMN or touches the canvas, preserving the audited pipeline.
 */

export interface LlmExtractor {
  extract(input: string): Promise<ProcessIR>;
}

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const IR_SYSTEM_PROMPT = `You convert process descriptions into a strict JSON Intermediate Representation (IR).
Return ONLY JSON matching this shape:
{
 "title": string,
 "roles": string[],
 "systems": string[],
 "dataObjects": string[],
 "assumptions": string[],
 "ambiguities": [{"about": string, "question": string, "options"?: string[]}],
 "steps": [{
   "id": string, "kind": "start|end|task|decision|approval|check|event|exception",
   "text": string, "name": string, "role"?: string, "system"?: string,
   "event"?: "message|timer|error|none",
   "branches"?: [{"condition": string, "steps": string[], "loopTo"?: string, "ends"?: boolean, "isDefault"?: boolean}],
   "provenance": string
 }]
}
Rules: object+verb task names; phrase decisions/approvals as questions; mark rework loops via branch.loopTo to an earlier step id; never invent steps not implied by the text — list uncertainties under "ambiguities".`;

export function createAnthropicExtractor(cfg: AnthropicConfig): LlmExtractor {
  const model = cfg.model ?? "claude-opus-4-8";
  const baseUrl = cfg.baseUrl ?? "https://api.anthropic.com";
  return {
    async extract(input: string): Promise<ProcessIR> {
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system: IR_SYSTEM_PROMPT,
          messages: [{ role: "user", content: input }],
        }),
      });
      if (!resp.ok) throw new Error(`LLM request failed: ${resp.status}`);
      const data = await resp.json();
      const textPart = data?.content?.find((c: any) => c.type === "text")?.text ?? "{}";
      const json = textPart.slice(textPart.indexOf("{"), textPart.lastIndexOf("}") + 1);
      return JSON.parse(json) as ProcessIR;
    },
  };
}
