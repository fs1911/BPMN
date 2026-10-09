import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// Version history (AI mocked): save → version 1; AI edit → save → version 2;
// unchanged save creates none; compare v1 with the current state (markers +
// change list); restore v1. Also: a library from before versions existed
// (database v1) survives the upgrade.
// Usage: node scripts/smoke-versions.mjs graph.json
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(process.argv[2], "utf8"));
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

// A library from before versions existed: database version 1, processes only.
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.evaluate(
  () =>
    new Promise((res) => {
      indexedDB.deleteDatabase("flowcraft").onsuccess = () => {
        const r = indexedDB.open("flowcraft", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("processes", { keyPath: "id" });
        r.onsuccess = () => {
          const t = r.result.transaction("processes", "readwrite");
          t.objectStore("processes").put({ id: "old1", name: "Alter Prozess", xml: '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><bpmn:process id="P"/></bpmn:definitions>', sourceText: "", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
          t.oncomplete = () => (r.result.close(), res());
        };
      };
    }),
);
await page.route("**/api/generate", (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  let g = graph;
  if (body.mode === "edit") {
    g = { ...body.graph, nodes: [...body.graph.nodes.map((n, i) => (i === 2 ? { ...n, name: n.name + " (neu)" } : n))] };
  }
  route.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(g) });
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
await page.getByText("📁 Bibliothek").click();
await page.waitForSelector(".lib-row, .lib-empty");
check("library from before the upgrade is still there", (await page.locator(".lib-name").allTextContents()).some((n) => n.includes("Alter Prozess")));
await page.locator(".lib-close").click();

const toast = async () => {
  await page.waitForSelector(".toast");
  const t = await page.locator(".toast").textContent();
  await page.locator(".toast").click();
  return t;
};
await page.locator(".ai-generate textarea").first().fill("Ausschreibung …");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
await page.keyboard.press("Control+s");
const t1 = await toast();
check(`first save → ${t1.slice(0, 80)}…`, t1.includes("Version 1"));
const shapesV1 = await page.locator(".djs-shape").count();

await page.locator(".ai-generate .row input").fill("Aufgabe umbenennen");
await page.getByText("Anwenden").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
await page.getByText("💾 In Bibliothek speichern").click();
const t2 = await toast();
check(`save after change → ${t2.slice(0, 60)}…`, t2.includes("Version 2"));
await page.getByText("💾 In Bibliothek speichern").click();
const t3 = await toast();
check(`save without change → ${t3.slice(0, 70)}…`, t3.includes("unverändert seit Version 2"));

await page.getByText("🕘 Versionen").click();
await page.waitForSelector(".lib-row");
check(`versions listed: ${(await page.locator(".lib-name").allTextContents()).join(" | ")}`, (await page.locator(".lib-row").count()) === 2);
await page.locator(".lib-row", { hasText: "Version 1" }).getByText("Mit aktuellem Stand vergleichen").click();
await page.waitForSelector(".cmp-changes li", { timeout: 15000 });
const changes = await page.locator(".cmp-changes li").allTextContents();
check(`comparison lists the change: ${changes.join(" | ").slice(0, 110)}`, changes.length === 1 && changes[0].includes("(neu)"));
check("changed element marked in both versions", (await page.locator(".cmp-pane").nth(0).locator(".diff-changed").count()) === 1 && (await page.locator(".cmp-pane").nth(1).locator(".diff-changed").count()) === 1);
await page.screenshot({ path: "/tmp/claude-0/s/versions-compare.png" });
await page.getByText("Version 1 wiederherstellen").click();
const t4 = await toast();
check(`restore → ${t4.slice(0, 70)}…`, t4.includes("Version 1 wiederhergestellt"));
check("diagram is version 1 again", (await page.locator(".djs-shape").count()) === shapesV1);
await page.waitForFunction(() => document.querySelector(".save-state")?.textContent?.includes("Gespeichert"));
const labels = await page.locator(".djs-label, .djs-shape text").allTextContents();
check("the renamed task is back to its old name", !labels.join(" ").includes("(neu)"));
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
