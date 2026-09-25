/**
 * Layout benchmark: lays out the test corpus and prints objective metrics
 * (crossings, overlaps, shape hits, …). With --svg <dir> it also writes a
 * simple SVG rendering of every case for visual inspection.
 *
 *   npx vite-node scripts/bench-layout.ts [--svg out/]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mapGraphToModel, sanitizeGraphIR } from "../src/core/ai";
import { generateFromTextSync } from "../src/core/ai";
import { BpmnModel, autoLayout, measureLayout } from "../src/core";
import { importBpmn } from "../src/core/xml";
import { CORPUS } from "../test/fixtures/processes";

const cases: Record<string, BpmnModel> = {};
for (const [name, ir] of Object.entries(CORPUS)) cases[`llm:${name}`] = mapGraphToModel(sanitizeGraphIR(ir).ir).model;
for (const f of ["bauantrag", "rechnungsfreigabe", "kunden-onboarding"]) {
  const m = importBpmn(readFileSync(`samples/${f}.bpmn`, "utf8"));
  autoLayout(m, m.rootProcessId);
  cases[`bpmn:${f}`] = m;
}
cases["rules:bestellung"] = generateFromTextSync(
  `Wenn eine Bestellanforderung eingeht, erfasst der Sachbearbeiter sie im System.
Der Einkäufer prüft die Anforderung auf Vollständigkeit.
Wenn die Anforderung unvollständig ist, zurück an den Antragsteller senden.
Der Abteilungsleiter gibt die Anforderung frei.
Das System erstellt eine Bestellung.
Der Prozess endet, wenn die Bestellung an den Lieferanten gesendet wurde.`,
).model;

const svgDir = process.argv.includes("--svg") ? process.argv[process.argv.indexOf("--svg") + 1] : undefined;
if (svgDir) mkdirSync(svgDir, { recursive: true });

const keys = ["crossings", "overlaps", "bundles", "shapeHits", "outsidePool", "nodeOverlaps", "labelCollisions", "bends", "length"] as const;
const total: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
console.log(["case".padEnd(24), ...keys.map((k) => k.padStart(11))].join(""));
for (const [name, m] of Object.entries(cases)) {
  const r = measureLayout(m);
  keys.forEach((k) => (total[k] += r[k]));
  console.log([name.padEnd(24), ...keys.map((k) => String(r[k]).padStart(11))].join(""));
  if (svgDir) writeFileSync(`${svgDir}/${name.replace(":", "_")}.svg`, toSvg(m));
}
console.log(["TOTAL".padEnd(24), ...keys.map((k) => String(total[k]).padStart(11))].join(""));

function toSvg(m: BpmnModel): string {
  const els: string[] = [];
  let maxX = 0;
  let maxY = 0;
  const grow = (x: number, y: number) => ((maxX = Math.max(maxX, x)), (maxY = Math.max(maxY, y)));
  for (const p of Object.values(m.participants)) {
    const b = p.bounds;
    grow(b.x + b.width, b.y + b.height);
    els.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="#333"/>`);
  }
  for (const l of Object.values(m.lanes)) {
    const b = l.bounds;
    els.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="#999"/>`);
    els.push(`<text x="${b.x + 4}" y="${b.y + 12}" font-size="10" fill="#777">${l.name ?? ""}</text>`);
  }
  for (const n of Object.values(m.nodes)) {
    const b = n.bounds;
    grow(b.x + b.width, b.y + b.height);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    if (n.type.endsWith("Event")) els.push(`<circle cx="${cx}" cy="${cy}" r="${b.width / 2}" fill="#fff" stroke="#000" stroke-width="${n.type === "endEvent" ? 3 : 1}"/>`);
    else if (n.type.endsWith("Gateway"))
      els.push(`<polygon points="${cx},${b.y} ${b.x + b.width},${cy} ${cx},${b.y + b.height} ${b.x},${cy}" fill="#fff" stroke="#000"/>`);
    else els.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="8" fill="#fff" stroke="#000"/>`);
    if (n.name && n.labelBounds) {
      const lb = n.labelBounds;
      els.push(`<text x="${lb.x + lb.width / 2}" y="${lb.y + 11}" font-size="9" text-anchor="middle">${n.name}</text>`);
    } else if (n.name) els.push(`<text x="${cx}" y="${cy}" font-size="9" text-anchor="middle">${n.name}</text>`);
  }
  for (const e of Object.values(m.edges)) {
    if (!e.waypoints) continue;
    for (const p of e.waypoints) grow(p.x, p.y);
    els.push(`<polyline points="${e.waypoints.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${e.isBackEdge ? "#c33" : "#036"}" stroke-width="1.3" marker-end="url(#a)"/>`);
    if (e.name && e.labelBounds) els.push(`<text x="${e.labelBounds.x}" y="${e.labelBounds.y + 10}" font-size="9" fill="#060">${e.name}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX + 40}" height="${maxY + 40}" style="background:#fff"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#036"/></marker></defs>${els.join("")}</svg>`;
}
