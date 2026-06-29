import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:4173/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
// bpmn-js renders the initial diagram
await page.waitForSelector(".bjs-canvas .djs-shape", { timeout: 8000 });
const seedShapes = await page.locator(".djs-element.djs-shape").count();
console.log("seed shapes:", seedShapes);
await page.screenshot({ path: "scripts/01-initial.png" });

// Generate from German text via the AI panel
await page.locator(".ai-generate textarea").first().fill(
  `Wenn eine Rechnung eingeht, erfasst der Sachbearbeiter sie im System.
Der Sachbearbeiter prüft die Rechnung gegen die Bestellung.
Wenn die Unterlagen unvollständig sind, zurück an die Erfassung der Rechnung senden.
Der Abteilungsleiter gibt die Rechnung frei.
Das System plant die Zahlung.
Der Prozess endet, wenn die Zahlung archiviert ist.`,
);
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForTimeout(1200);
const genShapes = await page.locator(".djs-element.djs-shape").count();
const genConns = await page.locator(".djs-element.djs-connection").count();
console.log("generated shapes:", genShapes, "connections:", genConns);
await page.screenshot({ path: "scripts/02-generated.png" });

// Human-in-the-loop: a preview bar must appear; accept it.
const previewVisible = await page.locator(".preview-bar").isVisible();
console.log("preview bar visible:", previewVisible);
await page.getByText("✓ Übernehmen").click();
await page.waitForTimeout(300);
const stillPreview = await page.locator(".preview-bar").count();
console.log("preview after accept:", stillPreview);

// Apply a German instruction
await page.locator(".ai-generate .row input").fill("Eine Freigabe durch den Manager vor der Zahlung hinzufügen");
await page.getByText("Anwenden", { exact: true }).click();
await page.waitForTimeout(1000);
const afterShapes = await page.locator(".djs-element.djs-shape").count();
console.log("after instruction shapes:", afterShapes);
await page.screenshot({ path: "scripts/03-after-instruction.png" });

// Cleanup (FlowCraft engine relayout)
await page.getByText("Diagramm aufräumen").click();
await page.waitForTimeout(1000);
await page.screenshot({ path: "scripts/04-cleanup.png" });

// Review tab
await page.getByText("Überprüfung", { exact: true }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: "scripts/05-review.png" });

// Dark mode
await page.locator(".toolbar button[title='Design wechseln']").click();
await page.waitForTimeout(300);
await page.screenshot({ path: "scripts/06-dark.png" });

await browser.close();

if (genShapes <= seedShapes || genConns < 4) {
  console.error("FAIL: generation did not produce a richer diagram");
  process.exit(1);
}
if (afterShapes <= genShapes) {
  console.error("FAIL: instruction did not add elements");
  process.exit(1);
}
if (!previewVisible || stillPreview !== 0) {
  console.error("FAIL: AI preview bar did not appear/clear on accept");
  process.exit(1);
}
const realErrors = errors.filter((e) => !/favicon|404/.test(e));
if (realErrors.length) {
  console.error("Console/page errors:\n" + realErrors.join("\n"));
  process.exit(1);
}
console.log("SMOKE OK");
