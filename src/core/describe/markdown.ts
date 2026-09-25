import { ProcessDescription, StepLink } from "./describe";

/** Plain-text/Markdown rendering of a process description. */
export function descriptionToMarkdown(d: ProcessDescription): string {
  const out: string[] = [];
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  out.push(`# Prozessbeschreibung: ${d.title}`, "", `Stand: ${d.date} · automatisch aus dem BPMN-Modell erzeugt`, "");
  for (const h of d.header) out.push(`- **${h.label}:** ${h.value}`);
  out.push("", "## Ablauf in Kürze", "", d.summary, "");
  if (d.mainPath.length) out.push(`**Hauptablauf:** ${d.mainPath.join(" → ")}`, "");
  out.push("## Auslöser und Ergebnisse", "");
  out.push(`- **Auslöser:** ${d.triggers.join("; ") || "—"}`, `- **Ergebnisse:** ${d.outcomes.join("; ") || "—"}`, "");
  if (d.roles.length) {
    out.push("## Rollen und Aufgaben", "", "| Rolle | Aufgaben |", "|---|---|");
    for (const r of d.roles) out.push(`| ${cell(r.name)} | ${cell(r.steps.map((s) => `${s.no}. ${s.name}`).join(", ") || "—")} |`);
    out.push("");
  }
  if (d.partners.length) {
    out.push("## Externe Partner", "", "| Partner | Kommunikation |", "|---|---|");
    for (const p of d.partners) {
      out.push(`| ${cell(p.name)} | ${cell(p.messages.map((m) => `${m.no}. ${m.direction === "out" ? "an" : "von"} ${p.name}: ${m.name || "Nachricht"}`).join("; ") || "—")} |`);
    }
    out.push("");
  }
  out.push("## Ablauf im Detail", "", "| Nr. | Schritt | Art | Verantwortlich | Beschreibung | Weiter |", "|---|---|---|---|---|---|");
  for (const s of d.steps) {
    const desc = [s.description, messageText(s), s.documentation].filter(Boolean).join(" ") || "—";
    out.push(`| ${s.no} | ${cell(s.name)} | ${s.typeLabel} | ${cell(s.role)} | ${cell(desc)} | ${cell(formatNext(s.next))} |`);
  }
  out.push("");
  if (d.openPoints.length) {
    out.push("## Offene Punkte", "");
    for (const p of d.openPoints) out.push(`- ${p}`);
    out.push("");
  }
  return out.join("\n");
}

/** "ja → 5; nein → 7 (zurück)" */
export function formatNext(next: StepLink[]): string {
  if (!next.length) return "—";
  return next.map((l) => `${l.label ? `${l.label} → ` : "→ "}${l.no}${l.loop ? " (zurück)" : ""}`).join("; ");
}

/** "Sendet „Offerte“ an Auftraggeber." / "Empfängt „Ausschreibung“ von Auftraggeber." */
export function messageText(s: { messages: { direction: "out" | "in"; partner: string; name: string }[] }): string {
  return s.messages
    .map((m) => `${m.direction === "out" ? "Sendet" : "Empfängt"} ${m.name ? `„${m.name}“` : "eine Nachricht"} ${m.direction === "out" ? "an" : "von"} ${m.partner}.`)
    .join(" ");
}
