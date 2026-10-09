import { chromium } from "playwright";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";
import { readFileSync } from "node:fs";

// Task-type icon switch: default off (plain tasks), on shows icons, and the
// choice survives a reload.
// Usage: node scripts/smoke-tasktypes.mjs graph.json
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(graph) }));

// All paths drawn in shapes: events/gateways are constant, so the difference
// between the two states is exactly the task icons. saveSVG (used by the PDF
// export) serializes this same canvas.
const iconPaths = () => page.locator(".djs-shape .djs-visual path").count();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape");
await page.locator(".ai-generate textarea").first().fill("gemockt");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
const toggle = page.locator(".tb-toggle input");
console.log("default checked:", await toggle.isChecked(), "| icon paths:", await iconPaths());
await page.screenshot({ path: "scripts/tasktypes-off.png" });
await toggle.click();
console.log("after click checked:", await toggle.isChecked(), "| icon paths:", await iconPaths());
await page.screenshot({ path: "scripts/tasktypes-on.png" });
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape");
console.log("after reload checked:", await page.locator(".tb-toggle input").isChecked());
await page.locator(".tb-toggle input").click(); // back to default for the next run
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no browser errors");
await browser.close();
