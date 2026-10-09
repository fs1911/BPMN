import { chromium } from "playwright";
import { readFileSync } from "node:fs";

// Process library in the browser (IndexedDB), AI responses mocked:
// generate → autosaved entry; reload → restored (diagram, text, questions);
// second process → own entry; open, rename, duplicate, delete;
// backup → wipe → restore.
// Usage: node scripts/smoke-library.mjs graph.json
const url = process.env.URL || "http://localhost:4173/";
const g1 = JSON.parse(readFileSync(process.argv[2], "utf8"));
g1.ambiguities = [{ about: "Frist", question: "Was passiert bei verpasster Frist?", options: [] }];
const g2 = {
  title: "Ferienantrag",
  lang: "de",
  lanes: [{ id: "l1", name: "Mitarbeiter" }, { id: "l2", name: "Teamleitung" }],
  nodes: [
    { id: "s", type: "startEvent", name: "Ferien geplant", lane: "l1", event: "none", source: "" },
    { id: "t1", type: "userTask", name: "Antrag stellen", lane: "l1", event: "none", source: "" },
    { id: "t2", type: "userTask", name: "Antrag prüfen", lane: "l2", event: "none", source: "" },
    { id: "e", type: "endEvent", name: "Antrag erledigt", lane: "l2", event: "none", source: "" },
  ],
  flows: [{ from: "s", to: "t1", condition: "", isDefault: false }, { from: "t1", to: "t2", condition: "", isDefault: false }, { from: "t2", to: "e", condition: "", isDefault: false }],
  pools: [], messageFlows: [], systems: [], dataObjects: [], assumptions: [], ambiguities: [],
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Offerte (umbenannt)" : undefined));
let next = g1;
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: { "content-type": "application/x-ndjson" }, body: JSON.stringify({ type: "result", graph: next }) + "\n" }));

const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const shapes = () => page.locator(".djs-shape").count();
const status = () => page.locator(".save-state").textContent();
const waitSaved = () => page.waitForFunction(() => document.querySelector(".save-state")?.textContent?.includes("Gespeichert"), null, { timeout: 8000 });
const generate = async (text) => {
  await page.locator(".ai-generate textarea").first().fill(text);
  await page.getByText("BPMN-Entwurf generieren").click();
  await page.waitForSelector(".preview-bar");
  await page.getByText("✓ Übernehmen").click();
  await waitSaved();
};
const libNames = async () => {
  await page.getByText("📁 Bibliothek").click();
  await page.waitForSelector(".lib-dialog");
  const names = await page.locator(".lib-name").allTextContents();
  return names;
};
const closeLib = () => page.locator(".lib-close").click();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape");
check("fresh start counts as saved", (await status()).includes("Gespeichert"));
check("fresh library is empty", (await libNames()).length === 0);
await closeLib();

await generate("Ausschreibung prüfen …");
const n1 = await shapes();
check(`generated process autosaved (${await status()})`, (await status()).includes("Gespeichert"));
check("toolbar shows the process title", (await page.locator(".doc-name").textContent()).includes("Ausschreibung"));

await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction((n) => document.querySelectorAll(".djs-shape").length === n, n1, { timeout: 8000 });
check("reload restores the diagram", (await shapes()) === n1);
check("reload restores the text field", (await page.locator(".ai-generate textarea").first().inputValue()) === "Ausschreibung prüfen …");
await page.getByText("Überprüfung", { exact: true }).click();
check("reload restores the open questions", (await page.locator(".questions .q-text").count()) === 1);
await page.getByText("KI-Modellierung", { exact: true }).click();

next = g2;
await page.getByText("＋ Neu").click();
await page.waitForFunction(() => document.querySelector(".doc-name")?.textContent === "Neuer Prozess");
await generate("Ferienantrag …");
let names = await libNames();
check(`second process has its own entry (${names.join(" | ")})`, names.length === 2 && names.some((n) => n.startsWith("Ferienantrag")) && names.some((n) => n.startsWith("Ausschreibung")));

await page.locator(".lib-row", { hasText: "Ausschreibung" }).getByText("Öffnen").click();
await page.waitForFunction((n) => document.querySelectorAll(".djs-shape").length === n, n1, { timeout: 8000 });
check("opening restores the first process", (await shapes()) === n1);

await page.locator(".doc-name").click(); // prompt → "Offerte (umbenannt)"
await waitSaved();
names = await libNames();
check(`rename via toolbar is saved (${names.join(" | ")})`, names.some((n) => n.startsWith("Offerte (umbenannt)")));
await page.locator(".lib-row", { hasText: "Ferienantrag" }).getByText("Duplizieren").click();
await page.waitForFunction(() => document.querySelectorAll(".lib-row").length === 3);
check("duplicate adds a copy", (await page.locator(".lib-name").allTextContents()).some((n) => n.includes("Ferienantrag (Kopie)")));
await page.locator(".lib-row", { hasText: "Ferienantrag (Kopie)" }).getByText("Löschen").click(); // confirm accepted
await page.waitForFunction(() => document.querySelectorAll(".lib-row").length === 2);
check("delete removes the entry", true);

// A generated process is kept even without clicking "Übernehmen" …
await closeLib();
next = g2;
await page.getByText("＋ Neu").click();
await page.waitForFunction(() => document.querySelector(".doc-name")?.textContent === "Neuer Prozess");
await page.locator(".ai-generate textarea").first().fill("ohne Übernehmen");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await waitSaved();
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector(".doc-name")?.textContent?.startsWith("Ferienantrag"), null, { timeout: 8000 });
check("preview not accepted, after reload still there", (await page.locator(".ai-generate textarea").first().inputValue()) === "ohne Übernehmen");
names = await libNames();
check(`… as its own entry (${names.join(" | ")})`, names.length === 3);
await closeLib();
// … and "Verwerfen" removes the draft entry and returns to the previous process.
await page.locator(".ai-generate textarea").first().fill("wird verworfen");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await waitSaved();
check(`draft saved while previewed (${(await libNames()).length} entries)`, (await page.locator(".lib-row").count()) === 4);
await closeLib();
await page.getByText("↩ Verwerfen").click();
await page.waitForFunction(() => !document.querySelector(".preview-bar"));
await waitSaved();
names = await libNames();
check(`reject removes the draft entry (${names.join(" | ")})`, names.length === 3);
check("reject returns to the previous process", (await page.locator(".doc-name").textContent()).startsWith("Ferienantrag"));
await page.locator(".lib-row.current").getByText("Löschen").click(); // back to two processes for the backup check
await page.waitForFunction(() => document.querySelectorAll(".lib-row").length === 2);

const [download] = await Promise.all([page.waitForEvent("download"), page.getByText("Bibliothek sichern").click()]);
const backupPath = "/tmp/claude-0/s/lib-backup.json";
await download.saveAs(backupPath);
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
check(`backup file holds both processes (${backup.processes.length})`, backup.format === "flowcraft-library" && backup.processes.length === 2);

// Wipe the browser library (like a new site address), then restore from the file.
await page.evaluate(() => new Promise((res) => { const r = indexedDB.deleteDatabase("flowcraft"); r.onsuccess = r.onerror = r.onblocked = res; }));
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape");
check("after wiping the library is empty", (await libNames()).length === 0);
await page.locator(".lib-foot input[type=file]").setInputFiles(backupPath);
await page.waitForSelector(".lib-note");
check(`restore message: ${await page.locator(".lib-note").textContent()}`, (await page.locator(".lib-row").count()) === 2);
await closeLib();
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no browser errors");
await browser.close();

// Explicit save button: success toast with read-back, and a clear error when storage is blocked.
{
  const b2 = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const p = await b2.newPage();
  await p.goto(url, { waitUntil: "networkidle" });
  await p.waitForSelector(".djs-shape");
  await p.getByText("💾 In Bibliothek speichern").click();
  await p.waitForSelector(".toast");
  const ok = await p.locator(".toast").textContent();
  check(`save button on untouched diagram: ${ok}`, ok.includes("gespeichert") && ok.includes("1 Prozess"));
  await p.keyboard.press("Control+s");
  await p.waitForTimeout(300);
  check("Ctrl+S saves too", (await p.locator(".toast").textContent()).includes("gespeichert"));
  await b2.close();

  const b3 = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const q = await b3.newPage();
  await q.addInitScript(() => { indexedDB.open = () => { throw new DOMException("The user denied permission to access the database.", "SecurityError"); }; });
  await q.goto(url, { waitUntil: "networkidle" });
  await q.waitForSelector(".djs-shape");
  await q.getByText("💾 In Bibliothek speichern").click();
  await q.waitForSelector(".toast.error");
  const err = await q.locator(".toast").textContent();
  check(`blocked storage is reported: ${err.slice(0, 90)}…`, err.includes("SecurityError") && (await q.locator(".save-state").textContent()).includes("fehlgeschlagen"));
  await b3.close();
}
