import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";

// Photos, scans and Word pictures for the AI (AI mocked): a photo, a PDF
// without text and a Word file with a picture become shrunk images listed
// under the text field; they go to the AI with the generation, a process
// comes back. HEIC and the image limit are explained.
// Usage: node scripts/smoke-images.mjs <dir with whiteboard.png scan.pdf anweisung.docx iphone.heic> graph.json
const url = process.env.URL || "http://localhost:4173/";
const [dir, graphFile] = process.argv.slice(2);
const graph = JSON.parse(readFileSync(graphFile, "utf8"));
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let payload;
await page.route("**/api/generate", (r) => {
  payload = JSON.parse(r.request().postData());
  return r.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse({ pools: [], messageFlows: [], ...graph }) });
});
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
const input = page.locator(".doc-import input[type=file]");
const items = page.locator(".img-attachments li");
const note = async () => (await page.locator(".import-note").textContent())?.trim() ?? "";

await input.setInputFiles(["whiteboard.png", "scan.pdf", "anweisung.docx"].map((f) => join(dir, f)));
await page.waitForFunction(() => document.querySelectorAll(".img-attachments li").length === 3 && !/Lese /.test(document.querySelector(".doc-import button")?.textContent ?? ""), null, { timeout: 30000 });
check(`3 images listed: ${(await items.allTextContents()).map((t) => t.replace("✕", "").trim()).join(" | ")}`, (await items.count()) === 3);
check("text of the Word file in the text field", (await page.locator(".ai-generate textarea").inputValue()).includes("Arbeitsanweisung Lieferung"));
console.log(`     note: ${await note()}`);
check("scan recognised and sent as picture", /Scan/.test(await note()));
const sizes = await items.evaluateAll((els) => els.map((e) => e.getAttribute("title")));
check(`shrunk: ${sizes.join(" | ")}`, sizes.every((t) => { const [w, h] = /(\d+)×(\d+)/.exec(t).slice(1).map(Number); return Math.max(w, h) <= 1600; }));

await page.locator(".img-remove").nth(2).click();
check("an image can be removed", (await items.count()) === 2);

await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
check(`sent with the text: ${payload.images.length} images, ${payload.text.length} chars`, payload.images.length === 2 && payload.text.includes("Arbeitsanweisung"));
check(`each image JPEG and within the limit (${payload.images.map((i) => Math.round(i.data.length / 1024) + " k").join(", ")})`, payload.images.every((i) => i.mediaType === "image/jpeg" && i.data.length <= 320000 && !("thumb" in i)));
check("chat shows the attachments", (await page.locator(".ai-msg, .msg, [class*=message]").allTextContents()).join(" ").includes("📎 2 Bild(er)") || (await page.getByText("📎 2 Bild(er)").count()) > 0);
check(`diagram generated (${await page.locator(".djs-shape").count()} shapes)`, (await page.locator(".djs-shape").count()) > 10);
await page.getByText("✓ Übernehmen").click();

// images only, no text
await page.locator(".ai-generate textarea").fill("");
check("images alone are enough to generate", await page.getByText("BPMN-Entwurf generieren").isEnabled());

// limit and HEIC
await input.setInputFiles(Array(5).fill(0).map(() => join(dir, "whiteboard.png")));
await page.waitForFunction(() => /Bilder pro Generierung/.test(document.querySelector(".import-note")?.textContent ?? ""), null, { timeout: 30000 });
check(`limit of 5 (${await items.count()}): ${await note()}`, (await items.count()) === 5);
await page.getByText("alle entfernen").click();
await input.setInputFiles(join(dir, "iphone.heic"));
await page.waitForFunction(() => /HEIC/.test(document.querySelector(".import-note")?.textContent ?? ""), null, { timeout: 10000 });
check(`HEIC explained: ${(await note()).slice(0, 80)}…`, true);
await page.screenshot({ path: join(dir, "smoke-images.png") });

// a new process starts without the images of the previous one
await input.setInputFiles(join(dir, "whiteboard.png"));
await page.waitForSelector(".img-attachments li");
await page.getByText("＋ Neu").click();
await page.waitForTimeout(300);
check("new process: images cleared", (await items.count()) === 0);
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
