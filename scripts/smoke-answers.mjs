import { chromium } from "playwright";
import { SSE_HEADERS, claudeSse } from "./lib/claude-sse.mjs";
import { readFileSync } from "node:fs";

// Answering the AI's open questions (AI responses mocked):
// generate with two questions → answer one → the edit request carries the
// answer, the answered question disappears, the other stays, the edit's new
// question is added → "Verwerfen" restores the previous questions.
// Usage: node scripts/smoke-answers.mjs graph.json
const url = process.env.URL || "http://localhost:4173/";
const base = JSON.parse(readFileSync(process.argv[2], "utf8"));
const q1 = { about: "Freigabe", question: "Wer gibt die Offerte frei, wenn die Geschäftsleitung abwesend ist?", options: ["Stellvertretung", "Niemand – Frist verlängern"] };
const q2 = { about: "Frist", question: "Was passiert, wenn die Eingabefrist verpasst wird?", options: [] };
const q3 = { about: "Stellvertretung", question: "Wer ist die Stellvertretung der Geschäftsleitung?", options: [] };
const generated = { ...base, ambiguities: [q1, q2] };

let editBody;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/generate", (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  let graph = generated;
  if (body.mode === "edit") {
    editBody = body;
    // the "AI" renames one task and raises a follow-up question
    graph = { ...body.graph, nodes: body.graph.nodes.map((n, i) => (i === 3 ? { ...n, name: n.name + " (inkl. Stellvertretung)" } : n)), ambiguities: [q3] };
  }
  route.fulfill({ status: 200, headers: SSE_HEADERS, body: claudeSse(graph) });
});
const questions = () => page.locator(".questions .q-text").allTextContents();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".bjs-canvas .djs-shape");
await page.locator(".ai-generate textarea").first().fill("gemockt");
await page.getByText("BPMN-Entwurf generieren").click();
await page.waitForSelector(".preview-bar");
console.log("chat hint:", (await page.locator(".msg.assistant").last().textContent()).includes("Rückfrage(n) der KI"));
await page.getByText("✓ Übernehmen").click();
await page.getByText("Überprüfung", { exact: true }).click();
console.log("questions before:", await questions());
console.log("submit disabled without answers:", await page.locator(".submit-answers").isDisabled());
await page.locator(".q-options .chip", { hasText: "Stellvertretung" }).click();
await page.locator(".submit-answers").click();
await page.waitForSelector(".preview-bar");
console.log("edit instruction has answer:", editBody.instruction.includes("Antwort: Stellvertretung") && editBody.instruction.includes(q1.question));
console.log("questions after edit:", await questions());
await page.screenshot({ path: "scripts/answers-01.png" });
await page.getByText("↩ Verwerfen").click();
await page.waitForTimeout(300);
console.log("questions after Verwerfen:", await questions());
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no browser errors");
await browser.close();
