import { chromium } from "playwright";

// Loads Word/PDF files through the real browser path (lazy-loaded mammoth /
// pdf.js + worker) and prints the Markdown that lands in the text field.
// Also checks that the generate request carries exactly that text.
// Usage: node scripts/smoke-import.mjs file.docx file.pdf …
const url = process.env.URL || "http://localhost:4173/";
const files = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("Failed to load resource")) errors.push(m.text()); });
let sent;
await page.route("**/api/generate", (route) => {
  sent = JSON.parse(route.request().postData() ?? "{}").text;
  route.fulfill({ status: 502, headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "api", message: "mock" }) });
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape", { timeout: 8000 });
for (const file of files) {
  await page.locator(".doc-import input[type=file]").setInputFiles(file);
  await page.waitForSelector(".import-note", { timeout: 20000 });
  const note = await page.locator(".import-note").textContent();
  const md = await page.locator(".ai-generate textarea").first().inputValue();
  const count = await page.locator(".char-count").textContent();
  console.log(`\n===== ${file}\nNOTE: ${note}\nCOUNT: ${count}\n${md}`);
}
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForTimeout(500);
const md = await page.locator(".ai-generate textarea").first().inputValue();
console.log("\nrequest carries textarea text:", sent === md);
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no browser errors");
await browser.close();
