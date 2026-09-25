import { create } from "zustand";
import type Modeler from "bpmn-js/lib/Modeler";
import { BpmnModel, ValidationIssue, validate } from "@core/index";
import { ai } from "@core/index";
import { ProcessDescription, describeProcess, descriptionToMarkdown } from "@core/describe";
import {
  cleanupDiagram,
  cleanupFlows,
  fitViewport,
  getModelFromModeler,
  getXml,
  loadModelIntoModeler,
} from "@ui/bpmn/bridge";
import { buildProcessPdf, downloadBlob, fileBase } from "@ui/export/pdf";

export type Theme = "light" | "dark";

export interface AiMessage {
  role: "user" | "assistant";
  text: string;
}

interface EditorState {
  modeler: Modeler | null;
  ready: boolean;
  theme: Theme;
  issues: ValidationIssue[];
  aiReview?: ai.ReviewReport;
  aiMessages: AiMessage[];
  aiBusy: boolean;
  /** live status line while the LLM is working. */
  aiProgress?: string;
  busy: boolean;
  /** an AI suggestion shown as a preview, awaiting accept/reject. */
  pending?: { prevXml: string; description: string };

  acceptPreview: () => void;
  rejectPreview: () => Promise<void>;

  setModeler: (m: Modeler) => void;
  setReady: (r: boolean) => void;
  toggleTheme: () => void;

  revalidate: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;

  cleanupAll: () => Promise<void>;
  cleanupFlowsOnly: () => Promise<void>;

  /** process description derived from the current diagram. */
  description?: ProcessDescription;
  refreshDescription: () => Promise<void>;
  exportPdf: () => Promise<void>;
  exportMarkdown: () => Promise<void>;

  exportXml: () => Promise<void>;
  importXml: (xml: string) => Promise<void>;

  generate: (text: string) => Promise<void>;
  instruct: (text: string) => Promise<void>;
}

export const useEditor = create<EditorState>((set, get) => ({
  modeler: null,
  ready: false,
  theme: "light",
  issues: [],
  aiMessages: [],
  aiBusy: false,
  busy: false,

  setModeler: (m) => set({ modeler: m }),
  setReady: (r) => set({ ready: r }),
  toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),

  revalidate: async () => {
    const m = get().modeler;
    if (!m) return;
    try {
      const model = await getModelFromModeler(m);
      set({ issues: validate(model), description: describeProcess(model, { extraOpenPoints: clarifications(get().aiReview) }) });
    } catch {
      /* mid-edit invalid XML; ignore */
    }
  },

  undo: () => get().modeler?.get<any>("commandStack").undo(),
  redo: () => get().modeler?.get<any>("commandStack").redo(),
  zoomIn: () => {
    const c = get().modeler?.get<any>("canvas");
    if (c) c.zoom(c.zoom() * 1.2);
  },
  zoomOut: () => {
    const c = get().modeler?.get<any>("canvas");
    if (c) c.zoom(c.zoom() / 1.2);
  },
  fit: () => {
    const m = get().modeler;
    if (m) fitViewport(m);
  },

  cleanupAll: async () => {
    const m = get().modeler;
    if (!m) return;
    set({ busy: true });
    try {
      await cleanupDiagram(m);
      await get().revalidate();
    } finally {
      set({ busy: false });
    }
  },
  cleanupFlowsOnly: async () => {
    const m = get().modeler;
    if (!m) return;
    set({ busy: true });
    try {
      await cleanupFlows(m);
      await get().revalidate();
    } finally {
      set({ busy: false });
    }
  },

  refreshDescription: async () => {
    const m = get().modeler;
    if (!m) return;
    const model = await getModelFromModeler(m);
    set({ description: describeProcess(model, { extraOpenPoints: clarifications(get().aiReview) }) });
  },

  exportPdf: async () => {
    const m = get().modeler;
    if (!m) return;
    set({ busy: true });
    try {
      await get().refreshDescription();
      const d = get().description!;
      const { svg } = await m.saveSVG();
      downloadBlob(await buildProcessPdf(svg, d), `${fileBase(d.title)}.pdf`);
    } catch (err) {
      alert(`PDF-Export fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      set({ busy: false });
    }
  },

  exportMarkdown: async () => {
    await get().refreshDescription();
    const d = get().description;
    if (!d) return;
    downloadBlob(new Blob([descriptionToMarkdown(d)], { type: "text/markdown" }), `${fileBase(d.title)}.md`);
  },

  exportXml: async () => {
    const m = get().modeler;
    if (!m) return;
    const xml = await getXml(m);
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prozess.bpmn";
    a.click();
    URL.revokeObjectURL(url);
  },
  importXml: async (xml) => {
    const m = get().modeler;
    if (!m) return;
    await m.importXML(xml);
    fitViewport(m);
    await get().revalidate();
  },

  acceptPreview: () =>
    set((s) => ({
      pending: undefined,
      aiMessages: [...s.aiMessages, { role: "assistant", text: "✓ Vorschlag übernommen." }],
    })),
  rejectPreview: async () => {
    const s = get();
    const m = s.modeler;
    if (!m || !s.pending) return;
    await m.importXML(s.pending.prevXml);
    fitViewport(m);
    await get().revalidate();
    set({ pending: undefined, aiMessages: [...get().aiMessages, { role: "assistant", text: "↩ Vorschlag verworfen, vorheriges Diagramm wiederhergestellt." }] });
  },

  generate: async (text) => {
    const m = get().modeler;
    if (!m) return;
    set({ aiBusy: true, aiProgress: "KI-Dienst wird kontaktiert…", aiMessages: [...get().aiMessages, { role: "user", text }] });
    try {
      const prevXml = await getXml(m);
      let result: { model: BpmnModel; review: ai.ReviewReport };
      let fallbackNote = "";
      try {
        result = await ai.generateViaLlm(text, {
          onProgress: (p) =>
            set({ aiProgress: p.phase === "thinking" ? "KI analysiert den Text…" : `KI schreibt das Modell… (${p.chars ?? 0} Zeichen)` }),
        });
      } catch (err) {
        // Offline / no key / API failure: fall back to the rule-based extractor, but say so.
        result = ai.generateFromTextSync(text);
        fallbackNote =
          (err instanceof ai.LlmUnavailableError ? `${(err as Error).message} ` : `KI-Fehler: ${(err as Error).message} `) +
          "Stattdessen wurde der regelbasierte Offline-Parser verwendet – er versteht nur einfache Schrittlisten zuverlässig.\n";
      }
      const { model, review } = result;
      await loadModelIntoModeler(m, model);
      await get().revalidate();
      const findings = review.findings?.length ? `\n⚠ ${review.findings.length} Qualitätshinweis(e) – siehe Überprüfung.` : "";
      set({
        aiReview: review,
        aiBusy: false,
        aiProgress: undefined,
        pending: { prevXml, description: `Generierter Entwurf: ${Object.keys(model.nodes).length} Elemente, ${review.roles.length} Rolle(n), ${review.loops.length} Schleife(n).` },
        aiMessages: [
          ...get().aiMessages,
          {
            role: "assistant",
            text: `${fallbackNote}${review.source === "llm" ? "KI-Modell" : "Regel-Parser"}: ${Object.keys(model.nodes).length} Elemente, ${review.roles.length} Rolle(n), ${review.decisions.length} Entscheidung(en), ${review.loops.length} Schleife(n). Konfidenz ${(review.confidence * 100).toFixed(0)} %.${findings}\nVorschau – bitte übernehmen oder verwerfen.`,
          },
        ],
      });
    } catch (err) {
      set({
        aiBusy: false,
        aiProgress: undefined,
        aiMessages: [...get().aiMessages, { role: "assistant", text: `Generierung fehlgeschlagen: ${(err as Error).message}` }],
      });
    }
  },

  instruct: async (text) => {
    const m = get().modeler;
    if (!m) return;
    set({ aiBusy: true });
    try {
      const prevXml = await getXml(m);
      const model = await getModelFromModeler(m);
      const res = ai.applyInstruction(model, text);
      if (res.applied) await loadModelIntoModeler(m, model);
      await get().revalidate();
      set({
        aiBusy: false,
        pending: res.applied ? { prevXml, description: res.description } : get().pending,
        aiMessages: [
          ...get().aiMessages,
          { role: "user", text },
          {
            role: "assistant",
            text:
              res.description +
              (res.assumptions.length ? `\nAnnahmen: ${res.assumptions.join("; ")}` : "") +
              (res.applied ? "\nVorschau – bitte übernehmen oder verwerfen." : ""),
          },
        ],
      });
    } catch (err) {
      set({ aiBusy: false, aiMessages: [...get().aiMessages, { role: "assistant", text: `Fehler: ${(err as Error).message}` }] });
    }
  },
}));

/** Open AI questions become open points of the process description. */
function clarifications(review?: ai.ReviewReport): string[] {
  return (review?.ambiguities ?? []).map((a) => `Klären: ${a.question}${a.options?.length ? ` (${a.options.join(" / ")})` : ""}`);
}
