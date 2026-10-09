import { describe, expect, it } from "vitest";
import { checkToken, handleAccess, makeToken, parseCodes } from "../server/access";

const env = { codes: "filip:alpha-1234-xyz, anna:beta-5678-uvw", secret: "s3cret" };
const app = async () => new Response("APP", { status: 200 });
const get = (path: string, cookie?: string) => new Request(`https://x.test${path}`, { headers: cookie ? { cookie } : {} });
const login = (code: string) =>
  new Request("https://x.test/__access/login", { method: "POST", body: new URLSearchParams({ code }), headers: { "content-type": "application/x-www-form-urlencoded" } });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

describe("access gate", () => {
  it("parses name:code pairs and ignores too-short codes", () => {
    expect([...parseCodes("filip:alpha-1234-xyz, kurz:abc, nur-code-ohne-name")]).toEqual([
      ["alpha-1234-xyz", "filip"],
      ["nur-code-ohne-name", "zugang"],
    ]);
  });

  it("fails closed without configured codes", async () => {
    expect((await handleAccess(get("/"), {}, app)).status).toBe(503);
    expect((await handleAccess(get("/"), { codes: " , x:short" }, app)).status).toBe(503);
  });

  it("shows the login page and blocks the API without a cookie", async () => {
    const page = await handleAccess(get("/"), env, app);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Zugangscode");
    const api = await handleAccess(new Request("https://x.test/api/generate", { method: "POST" }), env, app);
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toContain("json");
  });

  it("rejects a wrong code and lets a valid one in", async () => {
    expect((await handleAccess(login("falsch-123456"), env, app)).status).toBe(401);
    const ok = await handleAccess(login("beta-5678-uvw"), env, app);
    expect(ok.status).toBe(303);
    const c = cookieOf(ok);
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const res = await handleAccess(get("/index.html", c), env, app);
    expect(await res.text()).toBe("APP");
  });

  it("rejects forged, expired and revoked tokens", async () => {
    const token = await makeToken(env, "anna");
    expect(await checkToken(env, token)).toBe("anna");
    expect(await checkToken(env, token.replace("anna", "filip"))).toBeUndefined();
    expect(await checkToken({ ...env, secret: "other" }, token)).toBeUndefined();
    expect(await checkToken(env, token, Date.now() + 31 * 24 * 3600 * 1000)).toBeUndefined();
    expect(await checkToken({ ...env, codes: "filip:alpha-1234-xyz" }, token)).toBeUndefined();
  });

  it("logout clears the cookie", async () => {
    const res = await handleAccess(get("/__access/logout"), env, app);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});
