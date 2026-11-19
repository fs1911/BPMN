import type Modeler from "bpmn-js/lib/Modeler";

/**
 * Show diagram elements: select them, scroll the first into view and let all
 * of them flash briefly — used by the diagram check and the AI review, so a
 * click on a point shows what and where it means.
 */

const FLASH = "fc-flash";
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let flashed: string[] = [];

export function showElements(modeler: Modeler, ids: string[]): boolean {
  const registry = modeler.get<any>("elementRegistry");
  const canvas = modeler.get<any>("canvas");
  const elements = [...new Set(ids)].map((id) => registry.get(id)).filter(Boolean);
  if (!elements.length) return false;
  modeler.get<any>("selection").select(elements.filter((e: any) => !e.waypoints || elements.length === 1));
  try {
    canvas.scrollToElement(elements[0], { top: 120, bottom: 120, left: 160, right: 160 });
  } catch {
    /* older bpmn-js */
  }
  if (flashTimer) clearTimeout(flashTimer);
  for (const id of flashed) if (registry.get(id)) canvas.removeMarker(id, FLASH);
  flashed = elements.map((e: any) => e.id);
  for (const id of flashed) canvas.addMarker(id, FLASH);
  flashTimer = setTimeout(() => {
    for (const id of flashed) if (registry.get(id)) canvas.removeMarker(id, FLASH);
    flashed = [];
  }, 2400);
  return true;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim();

/**
 * Elements a text talks about: names in quotes („…“, "…") first, otherwise
 * every element whose name appears in the text (longest names first, so
 * "Rechnung prüfen" wins over "Rechnung"). Lanes count by their name, the
 * whole lane is shown.
 */
export function elementsForText(modeler: Modeler, text: string): string[] {
  const registry = modeler.get<any>("elementRegistry");
  const named: { id: string; name: string }[] = registry
    .getAll()
    .filter((e: any) => !e.labelTarget && e.businessObject?.name && e.type !== "bpmn:Participant" && e.type !== "bpmn:Process")
    .map((e: any) => ({ id: e.id, name: norm(String(e.businessObject.name)) }))
    .filter((e: { name: string }) => e.name.length >= 3);
  const quoted = [...text.matchAll(/[„"“»]([^"“”«]+)[“"”«]/g)].map((m) => norm(m[1]));
  if (quoted.length) {
    const hits = named.filter((e) => quoted.some((q) => q === e.name)).map((e) => e.id);
    if (hits.length) return hits;
    const partial = named.filter((e) => quoted.some((q) => q.length >= 4 && (e.name.includes(q) || q.includes(e.name)))).map((e) => e.id);
    if (partial.length) return partial;
  }
  const t = ` ${norm(text)} `;
  const hits: string[] = [];
  let rest = t;
  for (const e of [...named].sort((a, b) => b.name.length - a.name.length)) {
    if (e.name.length < 4) continue;
    if (rest.includes(` ${e.name} `)) {
      hits.push(e.id);
      rest = rest.split(` ${e.name} `).join("  ");
    }
  }
  return hits;
}

/** Elements with exactly this name (a role → its lane, a system → its data stores). */
export function elementsNamed(modeler: Modeler, name: string): string[] {
  const n = norm(name);
  return modeler
    .get<any>("elementRegistry")
    .getAll()
    .filter((e: any) => !e.labelTarget && e.businessObject?.name && norm(String(e.businessObject.name)) === n)
    .map((e: any) => e.id);
}
