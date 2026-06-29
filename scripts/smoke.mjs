import { chromium } from "playwright";

const url = process.env.URL || "http://localhost:4173/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 880 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".canvas .node", { timeout: 5000 });
const seedNodes = await page.locator(".canvas .node").count();
console.log("seed nodes:", seedNodes);
await page.screenshot({ path: "scripts/01-initial.png" });

// Generate from text via the AI panel (German)
await page.locator(".ai-generate textarea").first().fill(
  `Wenn eine Rechnung eingeht, erfasst der Sachbearbeiter sie im System.
Der Sachbearbeiter prüft die Rechnung gegen die Bestellung.
Wenn die Unterlagen unvollständig sind, zurück an die Erfassung der Rechnung senden.
Der Abteilungsleiter gibt die Rechnung frei.
Das System plant die Zahlung.
Der Prozess endet, wenn die Zahlung archiviert ist.`,
);
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForTimeout(600);
const genNodes = await page.locator(".canvas .node").count();
const genEdges = await page.locator(".canvas .edge").count();
const lanes = await page.locator(".canvas .lane").count();
console.log("generated nodes:", genNodes, "edges:", genEdges, "lanes:", lanes);
await page.screenshot({ path: "scripts/02-generated.png" });

// Apply an instruction (German)
await page.locator(".ai-generate .row input").fill("Eine Freigabe durch den Manager vor der Zahlung hinzufügen");
await page.getByText("Anwenden", { exact: true }).click();
await page.waitForTimeout(500);
const afterNodes = await page.locator(".canvas .node").count();
console.log("after instruction nodes:", afterNodes);
await page.screenshot({ path: "scripts/03-after-instruction.png" });

// Review tab
await page.getByText("Überprüfung", { exact: true }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: "scripts/04-review.png" });

// Dark mode
await page.locator(".toolbar button[title='Design wechseln']").click();
await page.waitForTimeout(200);
await page.screenshot({ path: "scripts/05-dark.png" });

await browser.close();

if (genNodes <= seedNodes || genEdges < 4 || lanes < 1) {
  console.error("FAIL: generation did not produce a richer diagram");
  process.exit(1);
}
if (afterNodes <= genNodes) {
  console.error("FAIL: instruction did not add elements");
  process.exit(1);
}
if (errors.length) {
  console.error("Console/page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("SMOKE OK");
