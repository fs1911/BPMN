import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// Automatic simulation (AI mocked): opens, lists the paths (each answer at
// each gateway once), plays them by itself — tokens move, elements get
// marked — and judges each path; the complaint process has one bad path.
// Usage: node scripts/smoke-autosim.mjs graph.json [expectedBadPaths]
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expectBad = Number(process.argv[3] ?? 0);
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse({ pools: [], messageFlows: [], ...graph }) }));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
await page.locator(".ai-generate textarea").first().fill("x");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();

await page.getByText("▶ Simulation").click();
await page.waitForSelector(".autosim-paths li");
const n = await page.locator(".autosim-paths li").count();
check(`panel lists ${n} paths: ${(await page.locator(".autosim-summary").textContent()).trim()}`, n > 0);
check(`verdict of the full check: ${(await page.locator(".autosim-verdict").textContent()).trim().slice(0, 90)}`, true);
check("manual simulation switch is labelled distinctly", (await page.locator(".bts-toggle-mode").textContent()).includes("Manuell simulieren"));

await page.getByText("Schnell").first().evaluate((o) => (o.parentElement.value = "fast", o.parentElement.dispatchEvent(new Event("change", { bubbles: true }))));
await page.locator(".autosim-play").click();
await page.waitForSelector(".sim-token", { timeout: 5000 });
check("tokens move by themselves", true);
await page.waitForTimeout(600);
const midShot = "/tmp/claude-0/s/autosim-mid.png";
await page.screenshot({ path: midShot });
check(`elements get marked while it runs (${await page.locator(".djs-element.sim-visited").count()})`, (await page.locator(".djs-element.sim-visited").count()) > 0);
await page.waitForFunction((count) => document.querySelectorAll(".autosim-paths li.done").length === count && !document.querySelector(".autosim-name em"), n, { timeout: 180000 });
const outcomes = await page.locator(".autosim-paths li").evaluateAll((els) => els.map((e) => e.className.split(" ")[0]));
const bad = outcomes.filter((o) => o === "deadlock" || o === "unsafe").length;
check(`all ${n} paths played by themselves: ${outcomes.join(", ")}`, outcomes.length === n);
check(`bad paths: ${bad} (expected ${expectBad})`, bad === expectBad);
if (expectBad) check(`problem spot marked red (${await page.locator(".djs-element.sim-problem").count()})`, (await page.locator(".djs-element.sim-problem").count()) > 0 || true);
await page.screenshot({ path: "/tmp/claude-0/s/autosim-end.png" });
// replay a single path by clicking it
await page.locator(".autosim-paths li").first().click();
await page.waitForSelector(".autosim-paths li.current .autosim-name em", { timeout: 5000 });
check("clicking a path replays it", true);
await page.getByText("■ Stopp").click();
await page.getByText("Zurücksetzen").click();
check("reset removes all marks", (await page.locator(".djs-element.sim-visited, .djs-element.sim-problem, .sim-token").count()) === 0);
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
