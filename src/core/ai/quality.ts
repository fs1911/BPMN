import { BpmnModel, isActivity } from "../model";

/**
 * Model-level quality assessment for AI output.
 *
 * Confidence used to be derived only from the number of ambiguities the
 * extractor itself reported — so a badly mangled diagram could still claim
 * 100 %. This check looks at the produced diagram (and the source text) instead
 * and turns concrete defects into findings; the confidence is derived from
 * those, so a broken result can no longer look trustworthy.
 */

export interface QualityAssessment {
  confidence: number;
  findings: string[];
}

const FRAGMENT_START = /^(wenn|falls|sonst|ansonsten|ist|sind|sobald|nachdem|parallel|gleichzeitig|dann|und|oder|if|otherwise|else|when|once|then|and|or|meanwhile)\b/i;
const FRAGMENT_END = /\b(der|die|das|den|dem|des|ein|eine|einen|einem|für|an|zu|mit|von|auf|und|oder|the|a|an|for|to|of|with|and|or)$/i;
const PARALLEL_CUE = /\b(gleichzeitig|parallel|zeitgleich|währenddessen|simultaneously|in parallel|at the same time|meanwhile)\b/i;
const CONDITION_CUE = /\b(wenn|falls|sonst|ansonsten|if|otherwise|unless)\b/i;

export function assessModel(
  model: BpmnModel,
  opts: { sourceText?: string; ambiguities?: number } = {},
): QualityAssessment {
  const findings: string[] = [];
  const nodes = Object.values(model.nodes);
  const seq = Object.values(model.edges).filter((e) => e.type === "sequenceFlow");
  const outs = (id: string) => seq.filter((e) => e.source === id);
  const ins = (id: string) => seq.filter((e) => e.target === id);

  // Names that are clearly copied sentence fragments.
  for (const n of nodes) {
    if (!isActivity(n.type) || !n.name) continue;
    const name = n.name.trim();
    const words = name.split(/\s+/).length;
    if (FRAGMENT_START.test(name) || FRAGMENT_END.test(name) || name.includes(",") || words > 7) {
      findings.push(`„${name}“ wirkt wie ein Satzfragment statt eines Aktivitätsnamens.`);
    }
  }

  for (const n of nodes) {
    if (!n.type.endsWith("Gateway")) continue;
    const o = outs(n.id);
    const i = ins(n.id);
    if (o.length <= 1 && i.length <= 1) {
      findings.push(`Gateway „${n.name || n.id}“ verzweigt und vereinigt nichts.`);
    }
    if (o.length > 1 && (n.type === "exclusiveGateway" || n.type === "inclusiveGateway")) {
      const unlabeled = o.filter((e) => !e.name && !e.isDefault).length;
      if (unlabeled) findings.push(`Verzweigung „${n.name || n.id}“: ${unlabeled} Ausgang/Ausgänge ohne Bedingung.`);
    }
  }

  // Reachability from the start events.
  const starts = nodes.filter((n) => n.type === "startEvent");
  if (!starts.length) findings.push("Kein Startereignis.");
  if (!nodes.some((n) => n.type === "endEvent")) findings.push("Kein Endereignis.");
  const reached = new Set<string>(starts.map((s) => s.id));
  const queue = [...reached];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of outs(id)) if (!reached.has(e.target)) (reached.add(e.target), queue.push(e.target));
  }
  const unreachable = nodes.filter((n) => (isActivity(n.type) || n.type.endsWith("Gateway")) && !reached.has(n.id) && n.type !== "boundaryEvent");
  if (unreachable.length) findings.push(`${unreachable.length} Element(e) vom Start aus nicht erreichbar.`);

  // Cross-check against the source text.
  const text = opts.sourceText ?? "";
  if (text) {
    if (PARALLEL_CUE.test(text) && !nodes.some((n) => n.type === "parallelGateway")) {
      findings.push("Der Text beschreibt Paralleles („gleichzeitig“/„parallel“), das Diagramm enthält aber keine Parallelverzweigung.");
    }
    if (CONDITION_CUE.test(text) && !nodes.some((n) => n.type.endsWith("Gateway"))) {
      findings.push("Der Text enthält Bedingungen („wenn“/„sonst“), das Diagramm aber keine Verzweigung.");
    }
    const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3).length;
    const activities = nodes.filter((n) => isActivity(n.type)).length;
    if (sentences >= 3 && activities < sentences / 2) {
      findings.push(`Nur ${activities} Aktivität(en) für ${sentences} beschreibende Sätze – vermutlich fehlen Schritte.`);
    }
  }

  const penalty = 0.12 * findings.length + 0.08 * (opts.ambiguities ?? 0);
  return { confidence: clamp(1 - penalty), findings };
}

const clamp = (v: number) => Math.round(Math.max(0.1, Math.min(1, v)) * 100) / 100;
