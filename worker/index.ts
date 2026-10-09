import { handleAccess } from "../server/access";
import { handleGenerate } from "../server/llm";

/**
 * Cloudflare Worker: access gate in front of everything, the AI endpoint at
 * /api/generate, and the built app (dist/) as static assets. Configuration in
 * wrangler.jsonc; secrets (ANTHROPIC_API_KEY, ACCESS_CODES, ACCESS_SECRET) are
 * set in the Cloudflare dashboard or with `wrangler secret put`.
 */

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ANTHROPIC_API_KEY?: string;
  ACCESS_CODES?: string;
  ACCESS_SECRET?: string;
  /** local tests only: a mock of the Anthropic API */
  ANTHROPIC_BASE_URL?: string;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleAccess(req, { codes: env.ACCESS_CODES, secret: env.ACCESS_SECRET }, async () => {
      if (new URL(req.url).pathname === "/api/generate") {
        return handleGenerate(req, { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });
      }
      return env.ASSETS.fetch(req);
    });
  },
};
