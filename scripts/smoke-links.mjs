import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// "Kreuzungen → Links" (AI mocked): a dense process with crossings → link
// event pairs as preview (tag "Vorschau"), the markers drawn by bpmn-js,
// no errors in the check; "Verwerfen" restores the diagram.
// Usage: node scripts/smoke-links.mjs ausschreibung.json [screenshot.png]
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(process.argv[2], "utf8"));
const shot = process.argv[3];
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(graph) }));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
await page.locator(".ai-generate textarea").fill("Ausschreibung bearbeiten");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
const shapes = await page.locator(".djs-shape").count();

await page.getByText("Kreuzungen → Links").click();
await page.waitForSelector(".preview-bar", { timeout: 30000 });
const bar = (await page.locator(".preview-bar").textContent()).replace(/\s+/g, " ");
check(`preview: ${bar.slice(0, 120)}`, /^Vorschau/.test(bar) && /Kreuzungen \d+ → \d+/.test(bar));
const links = await page.evaluate(() => [...document.querySelectorAll(".djs-element.djs-shape")].filter((g) => /IntermediateThrowEvent|IntermediateCatchEvent/i.test(g.getAttribute("data-element-id"))).length);
check(`link events drawn: ${links}`, links >= 2 && links % 2 === 0);
check("no errors in the diagram check", (await page.locator(".validation li.error").count()) === 0);
if (shot) await page.screenshot({ path: shot });
await page.getByText("↩ Verwerfen").click();
await page.waitForTimeout(500);
check("discard restores the diagram", (await page.locator(".djs-shape").count()) === shapes);
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
