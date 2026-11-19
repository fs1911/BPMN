import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// Process document (AI mocked): the AI fills purpose, scope and owner from
// the text; release with name → version 1; compact PDF and Word with the
// diagram; still released after a reload; a change shows "seither geändert".
// Usage: node scripts/smoke-document.mjs graph.json [outDir]
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const url = process.env.URL || "http://localhost:4173/";
const graph = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = process.argv[3];
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => (errors.push(`dialog: ${d.message()}`), d.dismiss()));
await page.route("**/api/generate", (r) => r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(graph) }));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
await page.locator(".ai-generate textarea").fill("Rechnungen verarbeiten …");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
await page.getByText("✓ Übernehmen").click();
await page.getByText("Beschreibung", { exact: true }).click();

const field = (label) => page.locator(".meta-field", { hasText: label }).locator("input, textarea");
check(`purpose from the AI: ${await field("Zweck").inputValue()}`, (await field("Zweck").inputValue()) === graph.purpose);
check(`scope from the AI: ${await field("Geltungsbereich").inputValue()}`, (await field("Geltungsbereich").inputValue()) === graph.scope);
check(`owner from the AI: ${await field("Prozesseigner").inputValue()}`, (await field("Prozesseigner").inputValue()) === graph.owner);
check("draft before release", (await page.locator(".release-state.draft").count()) === 1);

const download = async (label) => {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByText(label).click()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
};
const draftPdf = await download("📄 Prozessdokument PDF");
check(`draft PDF: ${draftPdf.name}, ${Math.round(draftPdf.bytes.length / 1024)} KB, marked ENTWURF`, draftPdf.name.endsWith("_Entwurf.pdf") && draftPdf.bytes.includes("ENTWURF"));

await field("Prozesseigner").fill("Leitung Finanzbuchhaltung (CFO)");
await page.getByLabel("Freigegeben durch").fill("Filip Subara");
await page.getByRole("button", { name: "Freigeben" }).click();
await page.waitForSelector(".release-state.released");
check(`released: ${(await page.locator(".release-state").textContent()).trim()}`, /Version 1 · freigegeben am .* durch Filip Subara/.test(await page.locator(".release-state").textContent()));

const pdf = await download("📄 Prozessdokument PDF");
check(`PDF: ${pdf.name}, ${Math.round(pdf.bytes.length / 1024)} KB, without ENTWURF`, pdf.name.endsWith(".pdf") && !pdf.name.includes("Entwurf") && !pdf.bytes.includes("ENTWURF"));
const docx = await download("📝 Prozessdokument Word");
const zip = await JSZip.loadAsync(docx.bytes);
const docXml = await zip.file("word/document.xml").async("string");
const png = await zip.file("word/media/diagramm.png")?.async("uint8array");
check(`Word: ${docx.name}, ${Math.round(docx.bytes.length / 1024)} KB`, docx.name.endsWith(".docx"));
check("Word has the profile", ["Zweck", "Geltungsbereich", "Prozesseigner", "Leitung Finanzbuchhaltung (CFO)", "Version 1"].every((t) => docXml.includes(t)));
check(`Word has the diagram (${png ? Math.round(png.length / 1024) : 0} KB PNG), landscape`, !!png && png.length > 5000 && docXml.includes('w:orient="landscape"'));
if (out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${out}/prozessdokument.pdf`, pdf.bytes);
  writeFileSync(`${out}/prozessdokument.docx`, docx.bytes);
}

// survives a reload; a change shows
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
await page.getByText("Beschreibung", { exact: true }).click();
await page.waitForSelector(".release-state");
check(`after reload still released: ${(await page.locator(".release-state").textContent()).trim()}`, (await page.locator(".release-state.released").count()) === 1);
check("profile kept", (await field("Prozesseigner").inputValue()) === "Leitung Finanzbuchhaltung (CFO)");
await page.getByText("Diagramm aufräumen").click();
await page.waitForTimeout(800);
await page.locator(".djs-shape").nth(3).click();
await page.keyboard.press("Delete");
await page.waitForTimeout(800);
check(`after a change: ${(await page.locator(".release-state").textContent()).trim()}`, (await page.locator(".release-state.changed").count()) === 1);
check("release button offers version 2", (await page.getByRole("button", { name: "Version 2 freigeben" }).count()) === 1);
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
