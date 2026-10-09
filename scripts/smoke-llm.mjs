import { chromium } from "playwright";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";
import { readFileSync } from "node:fs";

// Drives the LLM generation path in the real app with /api/generate mocked
// (streamed NDJSON, as the edge function sends it). No API key needed.
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(new URL("../samples/llm-reklamation.json", import.meta.url), "utf8"));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.route("**/api/generate", (route) =>
  route.fulfill({
    status: 200,
    headers: SSE_HEADERS,
    body: claudeSse(graph),
  }),
);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape", { timeout: 8000 });
await page.locator(".ai-generate textarea").first().fill(
  "Wenn ein Kunde reklamiert, schaut sich der Support das erst mal an. Ist es ein Garantiefall, geht das Gerät ans Lager, die schicken Ersatz raus. Sonst bekommt der Kunde ein Angebot für die Reparatur. Lehnt er ab, war's das. Parallel dazu wird im CRM ein Ticket gepflegt.",
);
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar", { timeout: 8000 });
const shapes = await page.locator(".djs-element.djs-shape").count();
const parallel = await page.locator(".djs-element[data-element-id^='parallelGateway']").count();
const msg = await page.locator(".msg.assistant").last().innerText();
console.log("shapes:", shapes, "parallel gateways:", parallel);
console.log("message:", msg.replace(/\n/g, " | "));
await page.screenshot({ path: "scripts/llm-01-generated.png" });
await page.getByText("Überprüfung", { exact: true }).click();
await page.waitForTimeout(200);
const source = await page.locator(".ai-review .source").innerText();
console.log(source);
await page.screenshot({ path: "scripts/llm-02-review.png" });
await browser.close();

if (parallel !== 2 || !msg.startsWith("KI-Modell") || !source.includes("Claude")) {
  console.error("FAIL: LLM path not used or diagram incomplete");
  process.exit(1);
}
if (errors.length) {
  console.error("Console/page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("SMOKE LLM OK");
