import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// Several processes in one text + improvement suggestions (AI mocked):
// - a long text with three processes → the scope check asks, nothing is generated
// - "Diesen Prozess erzeugen" generates only that one (focus sent), marked as done
// - suggestions appear in the review, are not built in; a click shows the element;
//   "Umsetzen" sends them as an AI edit (preview), "Verwerfen" greys them out
// Usage: node scripts/smoke-scope.mjs graph.json [screenshot.png]
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(process.argv[2], "utf8"));
const shot = process.argv[3];
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const task = graph.nodes.find((n) => /Task$/.test(n.type));
graph.improvements = [
  { kind: "automatisierung", title: "Erfassung automatisieren", description: "Die Erfassung kann das System übernehmen.", elements: [task.id] },
  { kind: "best-practice", title: "Frist für Antwort ergänzen", description: "Ohne Frist bleibt der Prozess hängen.", elements: [] },
];
const scope = {
  processes: [
    { title: "Rechnung verarbeiten", trigger: "Rechnung eingegangen", summary: "Erfassen, visieren, verbuchen." },
    { title: "Zahlungslauf durchführen", trigger: "jeden Freitag", summary: "Fällige Rechnungen bezahlen." },
    { title: "Mahnwesen", trigger: "monatlich", summary: "Offene Posten mahnen." },
  ],
  relation: "Der Zahlungslauf bezahlt die verbuchten Rechnungen.",
};
// the edit: like the AI, keep the current diagram (its ids) and change only the step
const editOf = (current) => {
  const g = JSON.parse(JSON.stringify(current));
  g.nodes.find((n) => n.name === task.name).type = "serviceTask";
  return { ...g, assumptions: [], ambiguities: [], improvements: [] };
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const calls = [];
await page.route("**/api/generate", (r) => {
  const body = JSON.parse(r.request().postData());
  calls.push(body);
  const answer = body.mode === "scope" ? scope : body.mode === "edit" ? editOf(body.graph) : graph;
  return r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(answer) });
});
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");

const text = "Kreditorenprozess. Rechnungen werden erfasst, visiert und verbucht. ".repeat(4) + "Jeden Freitag Zahlungslauf. ".repeat(6) + "Monatlich Mahnlauf bis zur Betreibung. ".repeat(6);
await page.locator(".ai-generate textarea").fill(text);
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".scope-choice");
check(`scope check asked first (${calls.map((c) => c.mode ?? "generate").join(", ")})`, calls.length === 1 && calls[0].mode === "scope");
check("three processes offered", (await page.locator(".scope-choice li").count()) === 3);
check("nothing generated yet", (await page.locator(".preview-bar").count()) === 0);
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-choice.png") });

await page.locator(".scope-choice li", { hasText: "Zahlungslauf" }).getByRole("button").click();
await page.waitForSelector(".preview-bar");
const gen = calls.at(-1);
check(`generated with focus: ${JSON.stringify(gen.focus).slice(0, 80)}…`, !gen.mode && /^Prozess: Zahlungslauf durchführen/.test(gen.focus) && gen.text === text);
check("marked as generated, others still offered", (await page.locator(".scope-choice li", { hasText: "Zahlungslauf" }).locator(".done").count()) === 1 && (await page.locator(".scope-choice li .done").count()) === 1);
check("chat says suggestions are not built in", (await page.locator(".msg.assistant").last().textContent()).includes("nichts davon ist eingebaut"));
await page.getByText("✓ Übernehmen").click();

await page.getByText("Überprüfung", { exact: true }).click();
check("two suggestions in the review", (await page.locator(".improvement").count()) === 2);
check("not built in: the step is still a user task", (await page.evaluate((id) => document.querySelectorAll(`[data-element-id^="ServiceTask"], [data-element-id^="serviceTask"]`).length, task.id)) === 0);
await page.locator(".improvement .locatable").first().click();
await page.waitForTimeout(150);
const sel = await page.evaluate(() => [...document.querySelectorAll(".djs-element.selected text")].map((t) => t.textContent.trim()).join(" "));
check(`click shows the step: ${sel}`, sel.includes(task.name.split(" ")[0]));
await page.locator(".improvement", { hasText: "Frist" }).getByText("Verwerfen").click();
check("dismissed one is greyed out", (await page.locator(".improvement.dismissed").count()) === 1);
await page.locator(".improvement", { hasText: "Erfassung" }).getByText("Umsetzen").click();
await page.waitForSelector(".preview-bar");
const edit = calls.at(-1);
check(`applied as AI edit: ${edit.instruction.slice(0, 70)}…`, edit.mode === "edit" && edit.instruction.includes("Erfassung automatisieren") && edit.instruction.includes(task.name));
const bar = await page.locator(".preview-bar").textContent();
check(`only the step changed: ${bar.replace(/\s+/g, " ").slice(0, 90)}`, /: 1 geändert/.test(bar) && !/hinzugefügt|entfernt/.test(bar));
check("marked as applied, list kept", (await page.locator(".improvement.applied").count()) === 1 && (await page.locator(".improvement").count()) === 2);
if (shot) await page.screenshot({ path: shot });
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
