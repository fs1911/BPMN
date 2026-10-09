import { chromium } from "playwright";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";
import { readFileSync } from "node:fs";

// Generates a diagram (LLM path mocked), opens the process description and
// exports the PDF. Usage: node scripts/smoke-pdf.mjs [graph.json] [out.pdf]
const url = process.env.URL || "http://localhost:4173/";
const graphFile = process.argv[2] || new URL("../samples/llm-reklamation.json", import.meta.url);
const outPdf = process.argv[3] || "scripts/export.pdf";
const graph = JSON.parse(readFileSync(graphFile, "utf8"));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
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
await page.locator(".ai-generate textarea").first().fill("Prozesstext (Antwort ist gemockt)");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar", { timeout: 8000 });
await page.getByText("✓ Übernehmen").click();
await page.getByText("Beschreibung", { exact: true }).click();
await page.waitForSelector(".desc-steps li");
const steps = await page.locator(".desc-steps li").count();
console.log("description steps:", steps);
await page.screenshot({ path: "scripts/pdf-01-description.png" });

const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".desc-actions button", { hasText: "PDF exportieren" }).click()]);
await download.saveAs(outPdf);
const head = readFileSync(outPdf).subarray(0, 5).toString();
console.log("pdf:", download.suggestedFilename(), head);
await browser.close();

if (steps < 5 || head !== "%PDF-") {
  console.error("FAIL: description or PDF missing");
  process.exit(1);
}
if (errors.length) {
  console.error("Console/page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("SMOKE PDF OK");
