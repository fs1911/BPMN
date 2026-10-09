import { handleGenerate } from "../../server/llm.ts";

/**
 * Netlify wrapper around the shared AI endpoint (see server/llm.ts). An edge
 * function, because generation can stream for minutes; edge functions only
 * need to start responding quickly.
 */
declare const Netlify: { env: { get(key: string): string | undefined } };

export default (req: Request) => handleGenerate(req, { apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });

export const config = { path: "/api/generate" };
