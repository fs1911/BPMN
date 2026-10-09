import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// BPMN standard in the app (AI mocked): a violation of ISO/IEC 19510 is shown
// with its clause, style hints as "Stil"; with the switch on, the violation
// goes back to the AI once and the corrected draft comes back; boundary events
// from the AI land on their activity.
// Usage: node scripts/smoke-norm.mjs bauetappe.json
const url = process.env.URL || "http://localhost:4173/";
const bauetappe = JSON.parse(readFileSync(process.argv[2], "utf8"));
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const node = (id, type, name, event = "none") => ({ id, type, name, lane: "", event, source: name, attachedTo: "", interrupting: true });
const broken = {
  title: "Antrag",
  lang: "de",
  lanes: [],
  nodes: [node("s", "startEvent", "Antrag eingegangen"), node("t", "userTask", "Antrag prüfen"), node("f", "intermediateCatchEvent", "Fehler aufgetreten", "error"), node("e", "endEvent", "Erledigt")],
  flows: [
    { from: "s", to: "t", condition: "", isDefault: false },
    { from: "t", to: "f", condition: "", isDefault: false },
    { from: "f", to: "e", condition: "", isDefault: false },
  ],
  pools: [],
  messageFlows: [],
  systems: [],
  dataObjects: [],
  assumptions: [],
  ambiguities: [],
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const calls = [];
let answer = broken;
await page.route("**/api/generate", async (r) => {
  const body = JSON.parse(r.request().postData());
  calls.push(body.mode ?? "generate");
  if (body.mode === "edit") {
    // the AI fixes the error event (it becomes a plain intermediate event)
    const fixed = JSON.parse(JSON.stringify(body.graph));
    const f = fixed.nodes.find((n) => n.event === "error");
    f.event = "none";
    f.type = "intermediateThrowEvent";
    await new Promise((res) => setTimeout(res, 400)); // let the progress text show
    return r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(fixed) });
  }
  return r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(answer) });
});
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
const generate = async () => {
  await page.locator(".ai-generate textarea").first().fill("Antrag prüfen …");
  await page.getByText("BPMN-Entwurf generieren").click();
  await page.waitForSelector(".preview-bar");
};

// 1) switch off (default): one call, the violation is shown with its clause
const box = page.locator(".self-correct input");
check("self-correction is off by default", !(await box.isChecked()));
await generate();
check(`one AI call (${calls.join(", ")})`, calls.length === 1);
const norm = page.locator(".validation li.error", { hasText: "Fehler-Ereignis mitten im Ablauf" });
check("violation listed as error", (await norm.count()) === 1);
check(`… with its clause: ${(await norm.locator(".vi-tag.norm").textContent())?.trim()}`, (await norm.locator(".vi-tag.norm").textContent())?.includes("10.5.4"));
await page.getByText("✓ Übernehmen").click();

// 2) switch on: the violation goes back once, the corrected draft arrives
await box.check();
calls.length = 0;
await page.locator(".ai-generate textarea").first().fill("Antrag prüfen …");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForFunction(() => /korrig/i.test(document.querySelector(".progress")?.textContent ?? ""), null, { timeout: 5000 });
check(`progress says it corrects: ${(await page.locator(".progress").textContent()).trim()}`, true);
await page.waitForSelector(".preview-bar");
check(`two AI calls (${calls.join(", ")})`, calls.join() === "generate,edit");
check("no error left in the check", (await page.locator(".validation li.error").count()) === 0);
await page.getByText("Überprüfung", { exact: true }).click();
check("review says what the self-correction did", (await page.getByText(/Selbstkorrektur: 1 von 1/).count()) > 0);
await page.getByText("KI-Modellierung", { exact: true }).click();
await page.getByText("✓ Übernehmen").click();

// 3) the switch survives a reload
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
check("switch remembered after reload", await page.locator(".self-correct input").isChecked());

// 4) the construction stage: boundary event on its activity, style hints marked as style, no error
answer = bauetappe;
calls.length = 0;
await generate();
check("clean draft: no correction call", calls.length === 1);
const boundary = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".djs-shape[data-element-id]")].find((g) => /boundary/i.test(g.getAttribute("data-element-id")));
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y };
});
check("boundary event drawn", !!boundary);
check("no errors in the check", (await page.locator(".validation li.error").count()) === 0);
const style = page.locator(".validation li", { hasText: "startet alle 3 parallelen Zweige neu" });
check("style hint for the jump back in front of the parallel split", (await style.count()) === 1);
check("… marked as style, not as the standard", (await style.locator(".vi-tag.style").count()) === 1 && (await style.locator(".vi-tag.norm").count()) === 0);
await page.screenshot({ path: "/tmp/claude-0/s/norm-bauetappe.png" });
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
