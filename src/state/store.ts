import { create } from "zustand";
import type Modeler from "bpmn-js/lib/Modeler";
import { ValidationIssue, validate } from "@core/index";
import { ai } from "@core/index";
import {
  cleanupDiagram,
  cleanupFlows,
  getModelFromModeler,
  getXml,
  loadModelIntoModeler,
} from "@ui/bpmn/bridge";

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
      set({ issues: validate(model) });
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
  fit: () => get().modeler?.get<any>("canvas").zoom("fit-viewport", "auto"),

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
    m.get<any>("canvas").zoom("fit-viewport", "auto");
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
    m.get<any>("canvas").zoom("fit-viewport", "auto");
    await get().revalidate();
    set({ pending: undefined, aiMessages: [...get().aiMessages, { role: "assistant", text: "↩ Vorschlag verworfen, vorheriges Diagramm wiederhergestellt." }] });
  },

  generate: async (text) => {
    const m = get().modeler;
    if (!m) return;
    set({ aiBusy: true, aiMessages: [...get().aiMessages, { role: "user", text }] });
    try {
      const prevXml = await getXml(m);
      const { model, review } = ai.generateFromTextSync(text);
      await loadModelIntoModeler(m, model);
      await get().revalidate();
      set({
        aiReview: review,
        aiBusy: false,
        pending: { prevXml, description: `Generierter Entwurf: ${Object.keys(model.nodes).length} Elemente, ${review.roles.length} Rolle(n), ${review.loops.length} Schleife(n).` },
        aiMessages: [
          ...get().aiMessages,
          {
            role: "assistant",
            text: `${Object.keys(model.nodes).length} Elemente generiert, ${review.roles.length} Rolle(n), ${review.decisions.length} Entscheidung(en), ${review.loops.length} Schleife(n). Konfidenz ${(review.confidence * 100).toFixed(0)} %. Vorschau – bitte übernehmen oder verwerfen.`,
          },
        ],
      });
    } catch (err) {
      set({
        aiBusy: false,
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
