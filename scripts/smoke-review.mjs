import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// Systems, review clicks and dictation (AI and microphone mocked):
// - systems of a step appear as data store symbols below it
// - a click on a question, assumption, role or step shows the place in the diagram
// - dictation appends the spoken text to the text field
// Usage: node scripts/smoke-review.mjs graph.json   (graph with systems, an assumption and a question)
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
// A fake microphone: speaks two passages, the second with "neuer Absatz".
await page.addInitScript(() => {
  class FakeRecognition {
    start() {
      this.timers = [
        setTimeout(() => this.emit("Die Kreditorenbuchhaltung erfasst die Rechnung", false), 100),
        setTimeout(() => this.emit("Die Kreditorenbuchhaltung erfasst die Rechnung im Abacus", true), 250),
        setTimeout(() => this.emit("neuer Absatz der Visumsverantwortliche prüft sie", true), 400),
      ];
    }
    emit(transcript, isFinal) {
      const result = [{ transcript }];
      result.isFinal = isFinal;
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
    stop() {
      this.timers.forEach(clearTimeout);
      setTimeout(() => this.onend?.(), 10);
    }
  }
  window.SpeechRecognition = FakeRecognition;
});
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(graph) }));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");

// dictation
await page.locator(".ai-generate textarea").fill("");
await page.getByText("🎤 Diktieren").click();
await page.waitForSelector(".dictation-live");
await page.waitForTimeout(700);
await page.getByText("■ Diktat beenden").click();
await page.waitForTimeout(200);
const dictated = await page.locator(".ai-generate textarea").inputValue();
check(`dictated into the text field: ${JSON.stringify(dictated)}`, dictated === "Die Kreditorenbuchhaltung erfasst die Rechnung im Abacus\n\nder Visumsverantwortliche prüft sie");
check("live line gone after stopping", (await page.locator(".dictation-live").count()) === 0);

// generate: systems as data stores
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
const storeCount = await page.locator('.djs-element.djs-shape[data-element-id*="DataStore"], .djs-element.djs-shape[data-element-id*="dataStore"]').count();
const storeNames = await page.evaluate(() =>
  [...document.querySelectorAll(".djs-element.djs-shape")].filter((g) => /dataStore/i.test(g.getAttribute("data-element-id")) && !/_label$/.test(g.getAttribute("data-element-id"))).length,
);
check(`data store symbols drawn: ${storeNames}`, storeNames === 5 || storeCount === 5);
check("data associations drawn", (await page.evaluate(() => [...document.querySelectorAll(".djs-element.djs-connection")].filter((g) => /association/i.test(g.getAttribute("data-element-id"))).length)) === 5);
check("no errors in the diagram check", (await page.locator(".validation li.error").count()) === 0);
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-diagram.png") });

const selected = () => page.evaluate(() => [...document.querySelectorAll(".djs-element.selected")].map((g) => g.getAttribute("data-element-id")));
const selectedNames = () =>
  page.evaluate(() => [...document.querySelectorAll(".djs-element.selected .djs-label, .djs-element.selected text")].map((t) => t.textContent.trim()).filter(Boolean));

// review clicks
await page.getByText("Überprüfung", { exact: true }).click();
await page.locator(".q-text.locatable").first().click();
await page.waitForTimeout(150);
check(`question shows its element: ${(await selectedNames()).join(" | ")}`, (await selectedNames()).join(" ").includes("Rechnung zurückweisen"));
check("… flashing", (await page.locator(".djs-element.fc-flash").count()) > 0);
await page.locator(".assumptions li.locatable").first().click();
await page.waitForTimeout(150);
check(`assumption shows the quoted step: ${(await selectedNames()).join(" | ")}`, (await selectedNames()).join(" ").includes("Rechnung visieren"));
await page.locator(".tag.locatable", { hasText: "Visumsverantwortlicher" }).click();
await page.waitForTimeout(150);
check(`role shows its lane: ${(await selected()).join(", ")}`, (await selected()).some((id) => /lane/i.test(id)));
await page.locator(".tag.locatable", { hasText: "Sorba" }).click();
await page.waitForTimeout(150);
check(`system shows its symbol: ${(await selected()).join(", ")}`, (await selected()).some((id) => /dataStore/i.test(id)));

// description: a step
await page.getByText("Beschreibung", { exact: true }).click();
await page.locator(".desc-steps li.locatable", { hasText: "Rechnung verbuchen" }).click();
await page.waitForTimeout(150);
check(`step in the description shows it: ${(await selectedNames()).join(" | ")}`, (await selectedNames()).join(" ").includes("Rechnung verbuchen"));
if (shot) await page.screenshot({ path: shot });
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
