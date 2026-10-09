import { chromium } from "playwright";

// The two right-hand areas (properties, AI) can be hidden from the toolbar:
// the diagram gets the width, the choice survives a reload, and both work
// again when shown.
// Usage: node scripts/smoke-panels.mjs
const url = process.env.URL || "http://localhost:4173/";
const check = (label, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
const canvasWidth = () => page.locator(".bjs-canvas").evaluate((el) => el.getBoundingClientRect().width);
const svgWidth = () => page.locator(".bjs-canvas .djs-container > svg").first().evaluate((el) => el.getBoundingClientRect().width);

const w0 = await canvasWidth();
check("both areas visible at first", (await page.locator(".bjs-properties").isVisible()) && (await page.locator("aside.side").isVisible()));
await page.getByRole("button", { name: "◨ Eigenschaften" }).click();
await page.getByRole("button", { name: "◨ KI-Bereich" }).click();
await page.waitForTimeout(200);
const w1 = await canvasWidth();
check(`both hidden, diagram wider: ${Math.round(w0)} → ${Math.round(w1)} px`, !(await page.locator(".bjs-properties").isVisible()) && !(await page.locator("aside.side").isVisible()) && w1 > w0 + 500);
check(`drawing area follows (${Math.round(await svgWidth())} px)`, (await svgWidth()) >= w1 - 2);
check("buttons show the state", (await page.getByRole("button", { name: "◨ KI-Bereich" }).getAttribute("aria-pressed")) === "false");

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".djs-shape");
check("still hidden after reload", !(await page.locator(".bjs-properties").isVisible()) && !(await page.locator("aside.side").isVisible()));

await page.getByRole("button", { name: "◨ Eigenschaften" }).click();
await page.getByRole("button", { name: "◨ KI-Bereich" }).click();
await page.locator(".djs-shape").nth(1).click();
await page.waitForTimeout(200);
check("shown again: properties of the selected element", (await page.locator(".bjs-properties .bio-properties-panel-header").count()) > 0);
check("shown again: AI area", await page.getByText("BPMN-Entwurf generieren").isVisible());
check(`diagram narrower again (${Math.round(await canvasWidth())} px)`, (await canvasWidth()) < w1 - 500);
check(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors", !errors.length);
await browser.close();
