import { handleAccess } from "../../server/access.ts";

/** Netlify wrapper around the shared access gate (see server/access.ts). */
declare const Netlify: { env: { get(key: string): string | undefined } };

export default (req: Request, context: { next: () => Promise<Response> }) =>
  handleAccess(req, { codes: Netlify.env.get("ACCESS_CODES"), secret: Netlify.env.get("ACCESS_SECRET") }, () => context.next());
