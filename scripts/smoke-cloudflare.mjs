import { chromium } from "playwright";
import { readFileSync } from "node:fs";

// End-to-end against the Cloudflare Worker running locally (`wrangler dev`)
// with a mock of the Anthropic API (records what the Worker sends):
// access gate → login → generate (stream passed through, mid-answer fallback)
// → diagram → library save → Word/PDF import assets through the gate.
// Usage: node scripts/smoke-cloudflare.mjs <recorded-request.json> [code] [docx] [pdf]
const url = process.env.URL || "http://127.0.0.1:8787/";
const [recorded, code = "test-code-1234", docx, pdf] = process.argv.slice(2);
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};

const anon = await fetch(new URL("/api/generate", url), { method: "POST", body: "{}" });
check(`API without login is blocked (${anon.status})`, anon.status === 401);
const asset = await fetch(url);
check(`app without login shows the code page (${asset.status})`, asset.status === 401 && (await asset.text()).includes("Zugangscode"));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.fill("input[name=code]", "falsch-12345");
await page.click("button[type=submit]");
check("wrong code rejected", (await page.locator(".err").textContent()).includes("ungültig"));
await page.fill("input[name=code]", code);
await page.click("button[type=submit]");
await page.waitForSelector(".bjs-canvas .djs-shape", { timeout: 15000 });
check("correct code opens the app", true);

await page.locator(".ai-generate textarea").first().fill("Ausschreibung prüfen, kalkulieren und Offerte einreichen …");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar", { timeout: 30000 });
const msg = await page.locator(".msg.assistant").last().textContent();
check(`generated via the Worker: ${msg.split("\n")[0].slice(0, 70)}`, msg.startsWith("KI-Modell"));
check(`diagram drawn (${await page.locator(".djs-shape").count()} shapes)`, (await page.locator(".djs-shape").count()) > 50);

const sent = JSON.parse(readFileSync(recorded, "utf8"));
const b = sent.body;
check(`upstream: model ${b.model}, stream ${b.stream}, max_tokens ${b.max_tokens}`, b.model === "claude-opus-5" && b.stream === true && b.max_tokens === 64000);
check(`upstream: fallbacks "${b.fallbacks}" + beta header "${sent.headers["anthropic-beta"]}"`, b.fallbacks === "default" && String(sent.headers["anthropic-beta"]).includes("server-side-fallback-2026-07-01"));
check(`upstream: thinking ${JSON.stringify(b.thinking)}, effort ${b.output_config?.effort}, format ${b.output_config?.format?.type}`, b.thinking?.type === "adaptive" && b.output_config?.effort === "medium" && b.output_config?.format?.type === "json_schema");
check("upstream: key only server-side, text wrapped as process description", sent.headers["x-api-key"] === "sk-test" && b.messages[0].content.startsWith("<process_description>"));

await page.getByText("✓ Übernehmen").click();
await page.getByText("💾 In Bibliothek speichern").click();
await page.waitForSelector(".toast");
check(`library on the Worker origin: ${await page.locator(".toast").textContent()}`, (await page.locator(".toast").textContent()).includes("gespeichert"));

for (const file of [docx, pdf].filter(Boolean)) {
  await page.locator(".doc-import input[type=file]").setInputFiles(file);
  await page.waitForFunction((f) => document.querySelector(".import-note")?.textContent?.includes(f.split("/").pop()), file, { timeout: 20000 });
  const len = (await page.locator(".ai-generate textarea").first().inputValue()).length;
  check(`${file.split("/").pop()} converted through the gate (${len} chars)`, len > 500);
}
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", errors.length === 0);
await browser.close();
