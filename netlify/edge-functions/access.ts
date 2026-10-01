/**
 * Access gate in front of the whole site (pages, assets and /api/generate).
 *
 * Every person gets their own access code, configured in the Netlify
 * environment variable ACCESS_CODES as comma-separated `name:code` pairs:
 *
 *   ACCESS_CODES = filip:7f3k-…, anna:q9xd-…
 *
 * Entering a code sets a signed, HttpOnly cookie valid for 30 days. Removing a
 * person from ACCESS_CODES revokes their cookie on the next request (the name
 * is checked on every request); changing ACCESS_SECRET logs everybody out.
 *
 * Fails closed: without ACCESS_CODES nothing is served.
 *
 *   POST /__access/login   form field `code` → cookie, redirect to /
 *   GET  /__access/logout  → cookie cleared, login page
 */

declare const Netlify: { env: { get(key: string): string | undefined } };

const COOKIE = "fc_access";
const MAX_AGE_S = 30 * 24 * 3600;
const enc = new TextEncoder();

export interface AccessEnv {
  codes?: string;
  secret?: string;
}

export function parseCodes(raw: string | undefined): Map<string, string> {
  const codes = new Map<string, string>(); // code → name
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf(":");
    const name = (i > 0 ? part.slice(0, i) : "").trim();
    const code = (i > 0 ? part.slice(i + 1) : part).trim();
    if (code.length >= 8) codes.set(code, name || "zugang");
  }
  return codes;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// With ACCESS_SECRET set, adding a colleague does not log everybody out.
const signingKey = (env: AccessEnv) => env.secret || env.codes || "";

export async function makeToken(env: AccessEnv, name: string, now = Date.now()): Promise<string> {
  const payload = `${encodeURIComponent(name)}.${Math.floor(now / 1000) + MAX_AGE_S}`;
  return `${payload}.${await hmac(signingKey(env), payload)}`;
}

/** Name of the signed-in person, or undefined. */
export async function checkToken(env: AccessEnv, token: string | undefined, now = Date.now()): Promise<string | undefined> {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [rawName, exp, sig] = parts;
  if (!same(sig, await hmac(signingKey(env), `${rawName}.${exp}`))) return undefined;
  if (!(Number(exp) * 1000 > now)) return undefined;
  const name = decodeURIComponent(rawName);
  // Revocation: the person must still be listed.
  return [...parseCodes(env.codes).values()].includes(name) ? name : undefined;
}

function readCookie(req: Request): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function loginPage(status: number, message = ""): Response {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowCraft – Anmeldung</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f4f6f9;--card:#fff;--text:#1d2733;--muted:#5b6b7c;--accent:#1f5fbf;--err:#b42318;--line:#d5dce5}
@media (prefers-color-scheme:dark){:root{--bg:#12171d;--card:#1b222b;--text:#e6ebf1;--muted:#9aa8b8;--accent:#6ea3ff;--err:#ff8a7a;--line:#2e3946}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px;width:100%;max-width:360px;box-sizing:border-box}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:var(--muted);font-size:14px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)}
button{margin-top:12px;width:100%;padding:10px;font:inherit;font-weight:600;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--err);margin:10px 0 0;font-size:14px}
</style></head><body>
<form method="post" action="/__access/login">
<h1>FlowCraft</h1><p>Bitte den persönlichen Zugangscode eingeben.</p>
<input name="code" type="password" autocomplete="current-password" required autofocus aria-label="Zugangscode">
<button type="submit">Anmelden</button>
${message ? `<div class="err" role="alert">${message}</div>` : ""}
</form></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function handleAccess(req: Request, env: AccessEnv, next: () => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  const codes = parseCodes(env.codes);
  if (codes.size === 0) {
    return new Response("Zugang nicht konfiguriert (ACCESS_CODES fehlt).", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (url.pathname === "/__access/login" && req.method === "POST") {
    let code = "";
    try {
      code = String((await req.formData()).get("code") ?? "").trim();
    } catch {
      /* empty code below */
    }
    let name: string | undefined;
    for (const [c, n] of codes) if (same(c, code)) name = n;
    if (!name) {
      await new Promise((r) => setTimeout(r, 600)); // slows down guessing
      return loginPage(401, "Code ungültig.");
    }
    return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie(await makeToken(env, name), MAX_AGE_S), "cache-control": "no-store" } });
  }
  if (url.pathname === "/__access/logout") {
    const res = loginPage(200, "");
    res.headers.set("set-cookie", cookie("", 0));
    return res;
  }

  if (await checkToken(env, readCookie(req))) return next();

  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "login_required" }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return loginPage(401);
}

export default (req: Request, context: { next: () => Promise<Response> }) =>
  handleAccess(req, { codes: Netlify.env.get("ACCESS_CODES"), secret: Netlify.env.get("ACCESS_SECRET") }, () => context.next());
