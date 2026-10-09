// Simulation smoke test (AI response mocked with the complaint process, which
// contains a real deadlock): finding listed under "Ablauf" with the involved
// elements selectable, token simulation toggles, a token runs, log in German.
// Usage: node scripts/smoke-simulation.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";
const graph = JSON.parse(readFileSync("samples/llm-reklamation.json", "utf8"));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse({ pools: [], messageFlows: [], ...graph }) }));
await page.goto("http://localhost:4173/", { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
await page.locator(".ai-generate textarea").first().fill("x");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
await page.waitForTimeout(800);
console.log("panel:", (await page.locator(".validation li").allTextContents()).filter((t) => t.includes("Ablauf")).join("\n  "));
await page.locator(".validation li", { hasText: "Ablauf" }).first().click();
console.log("selected after click:", await page.locator(".djs-element.selected").count());
console.log("toggle text:", await page.locator(".bts-toggle-mode").textContent());
await page.locator(".bts-toggle-mode").click();
await page.waitForTimeout(500);
// start a token at the start event and let it run
await page.locator(".bts-context-pad").first().click();
await page.waitForTimeout(4000);
await page.locator(".bts-toggle-log, [title*='protokoll' i]").first().click().catch(() => {});
await page.waitForTimeout(500);
console.log("log:", (await page.locator(".bts-log .bts-entry").allTextContents()).slice(0, 8).join(" | "));

console.log("errors:", errors);
await browser.close();
