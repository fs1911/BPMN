import { chromium } from "playwright";
import { readFileSync } from "node:fs";

// AI editing in the real app, with /api/generate mocked (no API key needed):
// generate → accept → instruction → edited diagram previewed with highlights → accept.
const url = process.env.URL || "http://localhost:4173/";
const generated = JSON.parse(readFileSync(new URL("../samples/llm-reklamation.json", import.meta.url), "utf8"));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

let editRequest;
await page.route("**/api/generate", async (route) => {
  const body = JSON.parse(route.request().postData());
  let graph = generated;
  if (body.mode === "edit") {
    editRequest = body;
    // what the LLM would return for "Nach 'Reklamation prüfen' die Seriennummer erfassen"
    graph = structuredClone(body.graph);
    const check = graph.nodes.find((n) => n.name === "Reklamation prüfen");
    const out = graph.flows.find((f) => f.from === check.id);
    graph.nodes.push({ id: "new1", type: "userTask", name: "Seriennummer erfassen", lane: check.lane, event: "none", source: "Seriennummer erfassen" });
    graph.flows.push({ from: "new1", to: out.to, condition: "", isDefault: false });
    out.to = "new1";
    graph.nodes.find((n) => n.name === "Garantiefall?").name = "Garantie gültig?";
  }
  await route.fulfill({ status: 200, headers: { "content-type": "application/x-ndjson" }, body: JSON.stringify({ type: "result", graph }) + "\n" });
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape");
await page.locator(".ai-generate textarea").first().fill("Reklamationsprozess (Antwort gemockt)");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
const shapesBefore = await page.locator(".djs-element.djs-shape").count();

await page.locator(".ai-generate .row input").fill("Nach der Prüfung die Seriennummer erfassen und die Frage in 'Garantie gültig?' umbenennen");
await page.getByText("Anwenden", { exact: true }).click();
await page.waitForSelector(".preview-bar");
const added = await page.locator(".djs-element.ai-added").count();
const changed = await page.locator(".djs-element.ai-changed").count();
const shapesAfter = await page.locator(".djs-element.djs-shape").count();
const msg = await page.locator(".msg.assistant").last().innerText();
console.log("sent graph nodes:", editRequest?.graph?.nodes?.length, "| shapes", shapesBefore, "→", shapesAfter, "| highlighted added/changed:", added, changed);
console.log("message:", msg.replace(/\n/g, " | "));
await page.screenshot({ path: "scripts/edit-01-preview.png" });
await page.getByText("✓ Übernehmen").click();
const stillMarked = await page.locator(".djs-element.ai-added, .djs-element.ai-changed").count();
await browser.close();

const ok = editRequest?.mode === "edit" && added === 1 && changed === 1 && shapesAfter === shapesBefore + 1 && stillMarked === 0 && msg.startsWith("KI-Modell");
if (!ok) {
  console.error("FAIL: AI edit not applied as expected", { added, changed, shapesBefore, shapesAfter, stillMarked });
  process.exit(1);
}
if (errors.length) {
  console.error("Console/page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("SMOKE EDIT OK");
