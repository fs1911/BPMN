import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_HEADERS, claudeSse } from "../scripts/lib/claude-sse.mjs";
import { handleGenerate } from "../server/llm";
import { generateViaLlm, MAX_IMAGES, MAX_IMAGE_CHARS } from "../src/core/ai";
import { BAUETAPPE } from "./fixtures/processes";

/** Photos / page images: browser → server → Claude (image blocks before the text). */

const jpeg = (n = 1000) => "/9j/" + "A".repeat(n);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x/api/generate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("server: images for the generation", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** captures what the server sends to the Claude API */
  const upstream = () => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(claudeSse(BAUETAPPE), { headers: SSE_HEADERS });
    });
    return sent;
  };

  it("sends the images as image blocks before the text", async () => {
    const sent = upstream();
    const res = await handleGenerate(post({ text: "Ablauf siehe Fotos", images: [{ mediaType: "image/jpeg", data: jpeg() }, { mediaType: "image/png", data: "iVBOR" }] }), { apiKey: "k" });
    expect(res.status).toBe(200);
    const content = sent[0].messages[0].content;
    expect(content.map((b: any) => b.type)).toEqual(["image", "image", "text"]);
    expect(content[0].source).toEqual({ type: "base64", media_type: "image/jpeg", data: jpeg() });
    expect(content[2].text).toContain("Ablauf siehe Fotos");
    expect(sent[0].system).toContain("photos of whiteboards");
  });

  it("images alone are enough; text alone still goes as plain text", async () => {
    const sent = upstream();
    expect((await handleGenerate(post({ text: "", images: [{ mediaType: "image/webp", data: "UklG" }] }), { apiKey: "k" })).status).toBe(200);
    expect(sent[0].messages[0].content.at(-1).text).toContain("Kein Text – der Prozess steht in den Bildern");
    expect((await handleGenerate(post({ text: "A dann B" }), { apiKey: "k" })).status).toBe(200);
    expect(typeof sent[1].messages[0].content).toBe("string");
  });

  it("refuses what it must not pass on", async () => {
    upstream();
    const img = { mediaType: "image/jpeg", data: jpeg() };
    const cases: [unknown, RegExp][] = [
      [{ text: "", images: [] }, /Prozesstext eingeben oder ein Bild/],
      [{ text: "x", images: Array(MAX_IMAGES + 1).fill(img) }, /Zu viele Bilder/],
      [{ text: "x", images: [{ mediaType: "image/svg+xml", data: "PHN2" }] }, /nur JPEG, PNG, WebP oder GIF/],
      [{ text: "x", images: [{ mediaType: "image/jpeg", data: "A".repeat(MAX_IMAGE_CHARS + 1) }] }, /zu gross/],
      [{ text: "x", images: "kaputt" }, /falschen Format/],
    ];
    for (const [body, msg] of cases) {
      const res = await handleGenerate(post(body), { apiKey: "k" });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(msg);
    }
    // oversized body: refused from the header, before parsing
    const big = await handleGenerate(post({ text: "x" }, { "content-length": String(50_000_000) }), { apiKey: "k" });
    expect(big.status).toBe(413);
  });

  it("a full request stays within the size the CPU budget was measured for", () => {
    const body = JSON.stringify({ text: "x".repeat(30_000), images: Array(MAX_IMAGES).fill({ mediaType: "image/jpeg", data: "A".repeat(MAX_IMAGE_CHARS) }) });
    expect(body.length).toBeLessThan(1_700_000);
  });
});

describe("client: generateViaLlm with images", () => {
  it("sends only type and data of each image (no preview, no name)", async () => {
    let payload: any;
    await generateViaLlm("", {
      images: [{ mediaType: "image/jpeg", data: jpeg(), name: "tafel.jpg", thumb: "data:…" } as any],
      fetchImpl: async (_u, init) => {
        payload = JSON.parse(String(init!.body));
        return new Response(claudeSse(BAUETAPPE), { headers: SSE_HEADERS });
      },
    });
    expect(payload).toEqual({ text: "", images: [{ mediaType: "image/jpeg", data: jpeg() }] });
  });
});
