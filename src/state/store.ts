import { create } from "zustand";
import type Modeler from "bpmn-js/lib/Modeler";
import { BpmnModel, ValidationIssue, layoutIssues, simulationIssues, validate } from "@core/index";
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
import { loadShowTaskTypes, saveShowTaskTypes, setShowTaskTypes } from "@ui/bpmn/plain-tasks";
import { initialXml } from "@ui/bpmn/bridge";
import { ProcessMeta, StoredProcess, contentHash, emptyMeta, newId } from "@core/library/library";
import type { ImageAttachment } from "@ui/import/images";
import { addVersion, deleteProcess, getLastOpened, getProcess, listProcesses, putProcess, requestPersistence, setLastOpened } from "@ui/library/db";

/** localStorage key of the self-correction switch (read when the store is created) */
const SELF_CORRECT_KEY = "flowcraft.selfCorrect";
const PANEL_KEYS = { props: "flowcraft.panel.props", ai: "flowcraft.panel.ai" } as const;

const SAMPLE_TEXT = `Wenn eine Bestellanforderung eingeht, erfasst der Sachbearbeiter sie im System.
Der Einkäufer prüft die Anforderung auf Vollständigkeit.
Wenn die Anforderung unvollständig ist, zurück an den Antragsteller senden.
Der Abteilungsleiter gibt die Anforderung frei.
Das System erstellt eine Bestellung.
Der Prozess endet, wenn die Bestellung an den Lieferanten gesendet wurde.`;

export type SaveState = "saved" | "unsaved" | "saving" | "error";

/** The library entry being edited; no id yet = not saved so far. */
export interface CurrentDoc {
  id?: string;
  name: string;
  /** name follows the process title until the user renames it */
  nameAuto: boolean;
  createdAt?: string;
}

export type Theme = "light" | "dark";

export interface AiMessage {
  role: "user" | "assistant";
  text: string;
}

interface InstructOptions {
  /** shown in the chat instead of the full instruction */
  shown?: string;
  /** questions this instruction answers (removed from the open list) */
  answered?: ai.Ambiguity[];
  /** no offline fallback: the rule parser cannot apply free answers */
  llmOnly?: boolean;
}

interface EditorState {
  modeler: Modeler | null;
  ready: boolean;
  theme: Theme;
  /** draw the person/envelope/gear icons of typed tasks */
  showTaskTypes: boolean;
  issues: ValidationIssue[];
  aiReview?: ai.ReviewReport;
  aiMessages: AiMessage[];
  aiBusy: boolean;
  /** live status line while the LLM is working. */
  aiProgress?: string;
  busy: boolean;
  /** an AI suggestion shown as a preview, awaiting accept/reject. */
  pending?: { prevXml: string; description: string; marked?: string[]; prevReview?: ai.ReviewReport; newDoc?: boolean; prevDoc?: CurrentDoc; prevMeta?: ProcessMeta };

  /** AI input field (saved with the process) */
  inputText: string;
  setInputText: (t: string) => void;
  /** purpose, scope, owner and release of the process (process document) */
  meta: ProcessMeta;
  setMeta: (patch: Partial<Omit<ProcessMeta, "release">>) => void;
  /** hash of the diagram on screen (to tell whether it changed since the release) */
  diagramHash?: string;
  /** release the process: next version, today, by whom; saves a library version */
  releaseProcess: (by: string) => Promise<void>;
  /** compact process document (profile + diagram) */
  exportProcessDocument: (format: "pdf" | "docx") => Promise<void>;
  /** photos / page images sent to the AI with the text (not saved in the library: too large) */
  inputImages: ImageAttachment[];
  setInputImages: (images: ImageAttachment[]) => void;
  doc: CurrentDoc;
  saveState: SaveState;
  saveError?: string;
  /** bumped when library contents change, so open lists reload */
  libraryVersion: number;
  /** schedule an autosave after a change */
  noteChange: () => void;
  saveNow: () => Promise<void>;
  newProcess: (opts?: { skipSave?: boolean }) => Promise<void>;
  openProcess: (id: string, opts?: { quiet?: boolean }) => Promise<void>;
  renameCurrent: (name: string) => Promise<void>;
  restoreLast: () => Promise<void>;
  libraryChanged: () => void;
  libraryOpen: boolean;
  /** explicit "In Bibliothek speichern": always writes, then reads back to verify */
  saveToLibrary: () => Promise<void>;
  toast?: { text: string; error?: boolean };
  showToast: (text: string, error?: boolean) => void;
  setLibraryOpen: (open: boolean) => void;
  versionsOpen: boolean;
  setVersionsOpen: (open: boolean) => void;
  autoSimOpen: boolean;
  /** send violations of the standard back to the AI once after generating (costs a second call) */
  selfCorrect: boolean;
  setSelfCorrect: (on: boolean) => void;
  /** right-hand panels: properties of the selected element, and the AI panel */
  panels: { props: boolean; ai: boolean };
  togglePanel: (which: "props" | "ai") => void;
  setAutoSimOpen: (open: boolean) => void;
  /** make a saved version the current state (the current state is saved as a version first) */
  restoreVersion: (xml: string, number: number) => Promise<void>;

  acceptPreview: () => void;
  rejectPreview: () => Promise<void>;

  setModeler: (m: Modeler) => void;
  setReady: (r: boolean) => void;
  toggleTheme: () => void;
  toggleTaskTypes: () => void;

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

  /**
   * offline: the rule-based parser instead of the AI (only on request, after the AI failed).
   * focus: only this one of the processes the scope check found; whole: all in one diagram (no check).
   */
  generate: (text: string, opts?: { offline?: boolean; focus?: ai.ScopeProcess; whole?: boolean }) => Promise<void>;
  /** the text describes several processes: the owner chooses before anything is generated */
  scopeChoice?: ScopeChoice;
  dismissScopeChoice: () => void;
  /** apply an AI improvement suggestion (as an AI edit with preview) or dismiss it */
  applyImprovement: (index: number) => Promise<void>;
  dismissImprovement: (index: number) => void;
  /** the AI failed on the last generation: the panel offers the rule-based parser */
  offlineOffer?: string;
  instruct: (text: string, opts?: InstructOptions) => Promise<void>;
  /** answers to the AI's open questions → one AI edit */
  answerQuestions: (answers: ai.AnsweredQuestion[]) => Promise<void>;
}

export interface ScopeChoice {
  text: string;
  processes: ai.ScopeProcess[];
  relation: string;
  /** titles already generated from this choice */
  done: string[];
}

/** Shorter texts are checked only by the generation itself (several processes rarely fit in a few lines). */
export const SCOPE_CHECK_MIN_CHARS = 500;

export const useEditor = create<EditorState>((set, get) => ({
  modeler: null,
  ready: false,
  theme: "light",
  showTaskTypes: loadShowTaskTypes(),
  issues: [],
  aiMessages: [],
  aiBusy: false,
  busy: false,
  inputText: SAMPLE_TEXT,
  doc: { name: "Neuer Prozess", nameAuto: true },
  saveState: "saved",
  libraryVersion: 0,
  libraryOpen: false,
  setLibraryOpen: (open) => set({ libraryOpen: open }),
  versionsOpen: false,
  setVersionsOpen: (open) => set({ versionsOpen: open }),
  autoSimOpen: false,
  setAutoSimOpen: (open) => set({ autoSimOpen: open }),
  panels: { props: readFlag(PANEL_KEYS.props, true), ai: readFlag(PANEL_KEYS.ai, true) },
  togglePanel: (which) => {
    const open = !get().panels[which];
    writeFlag(PANEL_KEYS[which], open);
    set({ panels: { ...get().panels, [which]: open } });
    // the canvas gets the freed width: let bpmn-js know its size changed
    requestAnimationFrame(() => {
      try {
        get().modeler?.get<any>("canvas").resized();
      } catch {
        /* no diagram yet */
      }
    });
  },
  selfCorrect: readFlag(SELF_CORRECT_KEY),
  setSelfCorrect: (on) => {
    writeFlag(SELF_CORRECT_KEY, on);
    set({ selfCorrect: on });
  },

  restoreVersion: async (xml, number) => {
    const m = get().modeler;
    if (!m) return;
    // Save the current state as a version first, so restoring can be undone.
    await get().saveToLibrary();
    if (get().saveState === "error") return;
    await m.importXML(xml);
    fitViewport(m);
    await get().revalidate();
    get().noteChange();
    await get().saveNow();
    get().showToast(`↩ Version ${number} wiederhergestellt. Der vorherige Stand ist als neueste Version gesichert.`);
  },

  setInputText: (t) => {
    set({ inputText: t });
    get().noteChange();
  },
  inputImages: [],
  setInputImages: (images) => set({ inputImages: images }),
  meta: emptyMeta(),
  setMeta: (patch) => {
    set({ meta: { ...get().meta, ...patch } });
    get().noteChange();
    void get().refreshDescription();
  },
  releaseProcess: async (by) => {
    const m = get().modeler;
    if (!m || !by.trim()) return;
    const hash = contentHash(await getXml(m));
    const version = (get().meta.release?.version ?? 0) + 1;
    set({ meta: { ...get().meta, release: { version, date: new Date().toISOString(), by: by.trim(), hash } }, diagramHash: hash });
    await get().saveToLibrary();
    await get().refreshDescription();
    get().showToast(`✓ Version ${version} freigegeben durch ${by.trim()} – das Prozessdokument kann jetzt erstellt werden.`);
  },
  exportProcessDocument: async (format) => {
    const m = get().modeler;
    if (!m) return;
    set({ busy: true });
    try {
      await get().refreshDescription();
      const d = get().description!;
      const { svg } = await m.saveSVG();
      const doc = { title: d.title, header: d.header, date: d.date, released: releaseState(get()) === "released" };
      const { buildProcessDocumentPdf, buildProcessDocumentDocx } = await import("@ui/export/process-document");
      const blob = format === "pdf" ? await buildProcessDocumentPdf(svg, doc) : await buildProcessDocumentDocx(svg, doc);
      downloadBlob(blob, `${fileBase(d.title)}${doc.released ? "" : "_Entwurf"}.${format}`);
    } catch (err) {
      alert(`Export fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      set({ busy: false });
    }
  },
  libraryChanged: () => set((s) => ({ libraryVersion: s.libraryVersion + 1 })),

  noteChange: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().saveNow(), AUTOSAVE_MS);
    void (async () => {
      const m = get().modeler;
      if (!m) return;
      const sig = signature(await getXml(m), get());
      if (sig !== lastSaved.sig || get().pending) set({ saveState: get().saveState === "saving" ? "saving" : "unsaved" });
    })();
  },

  showToast: (text, error) => {
    set({ toast: { text, error } });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: undefined }), error ? 12000 : 4000);
  },

  saveToLibrary: () => enqueueSave(async () => {
    const m = get().modeler;
    if (!m) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    set({ saveState: "saving" });
    try {
      const xml = await getXml(m);
      const s = get();
      const now = new Date().toISOString();
      const name = s.doc.nameAuto ? s.description?.title?.trim() || s.doc.name || "Unbenannter Prozess" : s.doc.name;
      const rec: StoredProcess = {
        id: s.doc.id ?? newId(),
        name,
        xml,
        sourceText: s.inputText,
        review: s.aiReview ? JSON.parse(JSON.stringify(s.aiReview)) : undefined,
        meta: JSON.parse(JSON.stringify(s.meta)),
        createdAt: s.doc.createdAt ?? now,
        updatedAt: now,
      };
      await putProcess(rec);
      // Read back: only report success when the library really holds this version.
      const back = await getProcess(rec.id);
      if (!back || back.xml !== xml || back.updatedAt !== now) throw new Error("Der Browser hat den Prozess nicht übernommen (Kontrolle nach dem Speichern fehlgeschlagen).");
      const count = (await listProcesses()).length;
      const version = await addVersion(rec.id, rec.name, xml);
      lastSaved = { sig: signature(xml, s), xml };
      void requestPersistence();
      setLastOpened(rec.id);
      set((st) => ({
        doc: { ...st.doc, id: rec.id, name: rec.name, createdAt: rec.createdAt },
        saveState: "saved",
        saveError: undefined,
        libraryVersion: st.libraryVersion + 1,
      }));
      get().showToast(
        `✓ „${rec.name}“ in der Bibliothek gespeichert – ${version.created ? `Version ${version.number}` : `unverändert seit Version ${version.number}`} · ${count} Prozess(e) in der Bibliothek.`,
      );
    } catch (err) {
      const e = err as Error & { name?: string };
      const msg = `${e.name && e.name !== "Error" ? e.name + ": " : ""}${e.message || String(err)}`;
      set({ saveState: "error", saveError: msg });
      get().showToast(`⚠ Speichern fehlgeschlagen: ${msg} – Häufige Ursache: privates/Inkognito-Fenster oder Browser-Einstellung „Websitedaten blockieren/beim Schliessen löschen“.`, true);
    }
  }),

  saveNow: () => enqueueSave(async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    const m = get().modeler;
    // What is on screen is saved, an AI preview included: closing the tab
    // without clicking "Übernehmen" must not lose a generated process.
    if (!m) return;
    const docAtStart = get().doc;
    const xml = await getXml(m);
    const s = get();
    // The process was switched while reading: that switch saved and will save again.
    if (s.doc !== docAtStart) return;
    const sig = signature(xml, s);
    if (sig === lastSaved.sig) {
      set({ saveState: "saved", saveError: undefined });
      return;
    }
    // A new, untouched diagram (only the text field changed) is not worth a library entry.
    if (!s.doc.id && xml === lastSaved.xml) {
      set({ saveState: "saved", saveError: undefined });
      return;
    }
    const now = new Date().toISOString();
    const name = s.doc.nameAuto ? s.description?.title?.trim() || "Unbenannter Prozess" : s.doc.name;
    const rec: StoredProcess = {
      id: s.doc.id ?? newId(),
      name,
      xml,
      sourceText: s.inputText,
      review: s.aiReview ? JSON.parse(JSON.stringify(s.aiReview)) : undefined,
      meta: JSON.parse(JSON.stringify(s.meta)),
      createdAt: s.doc.createdAt ?? now,
      updatedAt: now,
    };
    set({ saveState: "saving" });
    try {
      await putProcess(rec);
      if (!s.doc.id) void requestPersistence();
      if (get().doc !== docAtStart) {
        // Switched to another process while writing: this record belongs to the
        // previous one; never attach its id to the process now on screen.
        set((st) => ({ libraryVersion: st.libraryVersion + 1 }));
        return;
      }
      lastSaved = { sig, xml };
      setLastOpened(rec.id);
      set((st) => ({
        doc: { ...st.doc, id: rec.id, name: rec.name, createdAt: rec.createdAt },
        saveState: "saved",
        saveError: undefined,
        libraryVersion: st.libraryVersion + 1,
      }));
    } catch (err) {
      const e = err as Error;
      set({ saveState: "error", saveError: `${e.name && e.name !== "Error" ? e.name + ": " : ""}${e.message}` });
    }
  }),

  newProcess: async (opts = {}) => {
    const m = get().modeler;
    if (!m) return;
    if (!opts.skipSave) await get().saveNow();
    set({ doc: { name: "Neuer Prozess", nameAuto: true }, inputText: "", inputImages: [], meta: emptyMeta(), aiReview: undefined, aiMessages: [], pending: undefined });
    await m.importXML(initialXml());
    fitViewport(m);
    await markPristine();
    setLastOpened(undefined);
    await get().revalidate();
  },

  openProcess: async (id, opts = {}) => {
    const m = get().modeler;
    if (!m) return;
    await get().saveNow();
    const rec = await getProcess(id);
    if (!rec) throw new Error("Prozess nicht gefunden – wurde er gelöscht?");
    const review = rec.review as ai.ReviewReport | undefined;
    set({
      doc: { id: rec.id, name: rec.name, nameAuto: false, createdAt: rec.createdAt },
      inputText: rec.sourceText,
      inputImages: [],
      meta: { ...emptyMeta(), ...rec.meta },
      aiReview: review,
      pending: undefined,
      saveState: "saved",
      aiMessages: opts.quiet ? [] : [{ role: "assistant", text: `Prozess „${rec.name}“ geöffnet.` }],
    });
    await m.importXML(rec.xml);
    fitViewport(m);
    await markPristine();
    setLastOpened(rec.id);
    await get().revalidate();
  },

  renameCurrent: async (name) => {
    const clean = name.trim();
    if (!clean) return;
    set((s) => ({ doc: { ...s.doc, name: clean, nameAuto: false } }));
    if (get().doc.id) {
      lastSaved = { ...lastSaved, sig: "" }; // force a write of the new name
      await get().saveNow();
    }
  },

  restoreLast: async () => {
    const id = getLastOpened();
    if (!id) return;
    try {
      await get().openProcess(id, { quiet: true });
    } catch {
      setLastOpened(undefined);
    }
  },

  setModeler: (m) => set({ modeler: m }),
  setReady: (r) => set({ ready: r }),
  toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
  toggleTaskTypes: () => {
    const show = !get().showTaskTypes;
    saveShowTaskTypes(show);
    set({ showTaskTypes: show });
    const m = get().modeler;
    if (m) setShowTaskTypes(m, show);
  },

  revalidate: async () => {
    const m = get().modeler;
    if (!m) return;
    try {
      const model = await getModelFromModeler(m);
      set({ diagramHash: contentHash(await getXml(m)) });
      set({ issues: [...simulationIssues(model), ...validate(model), ...layoutIssues(model)], description: describeProcess(model, describeOpts(get())) });
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
    set({ description: describeProcess(model, describeOpts(get())) });
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
    await get().saveNow();
    // An imported file becomes a new library entry.
    set({ doc: { name: "Importierter Prozess", nameAuto: true }, aiReview: undefined, pending: undefined });
    await m.importXML(xml);
    fitViewport(m);
    await get().revalidate();
  },

  acceptPreview: () => {
    const { modeler, pending } = get();
    if (modeler && pending?.marked) unhighlight(modeler, pending.marked);
    set((s) => ({
      pending: undefined,
      aiMessages: [...s.aiMessages, { role: "assistant", text: "✓ Vorschlag übernommen." }],
    }));
  },
  rejectPreview: async () => {
    const s = get();
    const m = s.modeler;
    if (!m || !s.pending) return;
    const { prevDoc, newDoc } = s.pending;
    if (newDoc && prevDoc) {
      // Let a running autosave finish first, so the draft's id is known (or it was never written).
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      await saveQueue;
      const draft = get().doc;
      // The rejected draft had its own library entry: remove it and go back to the previous process.
      if (draft.id && draft.id !== prevDoc.id) await deleteProcess(draft.id).catch(() => undefined);
      set((st) => ({ doc: prevDoc, meta: s.pending!.prevMeta ?? emptyMeta(), libraryVersion: st.libraryVersion + 1 }));
      setLastOpened(prevDoc.id);
    }
    await m.importXML(s.pending.prevXml);
    fitViewport(m);
    if (newDoc) await markPristine(); // the previous process was saved before generating
    await get().revalidate();
    set({ pending: undefined, ...(s.pending.newDoc || s.pending.prevReview ? { aiReview: s.pending.prevReview } : {}), aiMessages: [...get().aiMessages, { role: "assistant", text: "↩ Vorschlag verworfen, vorheriges Diagramm wiederhergestellt." }] });
  },

  generate: async (text, opts = {}) => {
    const m = get().modeler;
    if (!m) return;
    set({ offlineOffer: undefined });
    if (text.length > ai.MAX_TEXT_CHARS) {
      // Checked here so an over-long document never silently falls back to the offline parser.
      set({ aiMessages: [...get().aiMessages, { role: "assistant", text: `Text zu lang (${text.length.toLocaleString("de-CH")} Zeichen, maximal ${ai.MAX_TEXT_CHARS.toLocaleString("de-CH")}). Bitte Abschnitte ohne Ablauf (Zweck, Begriffe, Änderungshistorie …) löschen.` }] });
      return;
    }
    const images = get().inputImages;
    // Several processes in one text (own trigger, own outcome each): ask before generating.
    if (!opts.offline && !opts.focus && !opts.whole && text.trim().length >= SCOPE_CHECK_MIN_CHARS) {
      set({ aiBusy: true, aiProgress: "KI prüft, ob der Text einen oder mehrere Prozesse beschreibt…", scopeChoice: undefined });
      let scope: ai.ScopeResult | undefined;
      try {
        scope = await ai.checkScopeViaLlm(text);
      } catch {
        // the generation below reports a missing AI properly
      }
      set({ aiBusy: false, aiProgress: undefined });
      if (scope && scope.processes.length > 1) {
        set({
          scopeChoice: { text, processes: scope.processes, relation: scope.relation, done: [] },
          aiMessages: [
            ...get().aiMessages,
            {
              role: "assistant",
              text:
                `❓ Der Text beschreibt ${scope.processes.length} eigenständige Prozesse (je eigener Auslöser und eigenes Ergebnis):\n` +
                scope.processes.map((p, i) => `${i + 1}. ${p.title} – Auslöser: ${p.trigger}`).join("\n") +
                (scope.relation ? `\n${scope.relation}` : "") +
                "\nEmpfehlung: je Prozess ein eigenes Diagramm (übersichtlicher, keine Kreuzungen zwischen fremden Abläufen). Bitte oben auswählen.",
            },
          ],
        });
        return;
      }
    }
    if (opts.focus) set({ scopeChoice: get().scopeChoice && { ...get().scopeChoice!, done: [...new Set([...get().scopeChoice!.done, opts.focus.title])] } });
    else if (opts.whole) set({ scopeChoice: undefined });
    const imageNote = images.length ? `📎 ${images.length} Bild(er): ${images.map((i) => i.name).join(", ")}` : "";
    const shownText = text.length > 400 ? `${text.slice(0, 300).trimEnd()} … (${text.length.toLocaleString("de-CH")} Zeichen)` : text;
    const shown = [opts.focus ? `▶ Nur Prozess „${opts.focus.title}“ aus diesem Text:` : "", shownText, imageNote].filter(Boolean).join("\n");
    set({ aiBusy: true, aiProgress: "KI-Dienst wird kontaktiert…", aiMessages: [...get().aiMessages, { role: "user", text: shown }] });
    try {
      await get().saveNow(); // the open process is saved before a new one replaces it on screen
      const prevReview = get().aiReview;
      const prevXml = await getXml(m);
      let result: { model: BpmnModel; review: ai.ReviewReport };
      try {
        if (opts.offline) {
          result = ai.generateFromTextSync(text);
        } else {
          let correcting = false;
          const choice = get().scopeChoice;
          result = await ai.generateViaLlm(text, {
            images,
            ...(opts.focus ? { focus: ai.focusFor(opts.focus, choice?.processes ?? [opts.focus]) } : {}),
            selfCorrect: get().selfCorrect,
            onProgress: (p) => {
              if (p.phase === "correcting") correcting = true;
              set({
                aiProgress:
                  p.phase === "correcting"
                    ? `KI korrigiert ${p.violations} Normverstoss/-verstösse…`
                    : correcting
                      ? p.phase === "thinking" ? "KI plant die Korrektur…" : `KI schreibt das korrigierte Modell… (${p.chars ?? 0} Zeichen)`
                      : p.phase === "thinking" ? "KI analysiert den Text…" : `KI schreibt das Modell… (${p.chars ?? 0} Zeichen)`,
              });
            },
          });
        }
      } catch (err) {
        // No silent switch to the rule-based parser: it understands only simple
        // step lists, and its result looked like a (bad) AI result. Say what
        // failed and let the user decide.
        set({
          aiBusy: false,
          aiProgress: undefined,
          offlineOffer: text.trim() ? text : undefined,
          aiMessages: [
            ...get().aiMessages,
            {
              role: "assistant",
              text:
                `⚠ KI nicht verfügbar – es wurde nichts erzeugt.\n${err instanceof ai.LlmUnavailableError ? "" : "KI-Fehler: "}${(err as Error).message}` +
                (text.trim() ? "\nOhne KI geht es nur mit dem Regel-Parser (versteht nur einfache Schrittlisten, keine Zeichnungen und Bilder) – Knopf unter „BPMN-Entwurf generieren“." : ""),
            },
          ],
        });
        return;
      }
      const { model, review } = result;
      // A newly generated process goes into its own library entry instead of overwriting the open one.
      const prevDoc = get().doc;
      const prevMeta = get().meta;
      set({ doc: { name: "Neuer Prozess", nameAuto: true }, meta: { ...emptyMeta(), ...review.profile } });
      await loadModelIntoModeler(m, model);
      await get().revalidate();
      const findings = review.findings?.length ? `\n⚠ ${review.findings.length} Qualitätshinweis(e) – siehe Überprüfung.` : "";
      const questions = review.ambiguities.length ? `\n❓ ${review.ambiguities.length} Rückfrage(n) der KI – unter „Überprüfung“ beantworten.` : "";
      const ideas = review.improvements?.length ? `\n💡 ${review.improvements.length} Verbesserungsvorschlag/-vorschläge – unter „Überprüfung“, nichts davon ist eingebaut.` : "";
      set({
        aiReview: review,
        aiBusy: false,
        aiProgress: undefined,
        pending: { prevXml, prevReview, newDoc: true, prevDoc, prevMeta, description: `Generierter Entwurf: ${Object.keys(model.nodes).length} Elemente, ${review.roles.length} Rolle(n), ${review.loops.length} Schleife(n).` },
        aiMessages: [
          ...get().aiMessages,
          {
            role: "assistant",
            text: `${review.source === "llm" ? "KI-Modell" : "⚠ Regel-Parser (ohne KI)"}: ${Object.keys(model.nodes).length} Elemente, ${review.roles.length} Rolle(n), ${review.decisions.length} Entscheidung(en), ${review.loops.length} Schleife(n). Konfidenz ${(review.confidence * 100).toFixed(0)} %.${findings}${questions}${ideas}\nVorschau – bitte übernehmen oder verwerfen.`,
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

  dismissScopeChoice: () => set({ scopeChoice: undefined }),

  applyImprovement: async (index) => {
    const review = get().aiReview;
    const imp = review?.improvements?.[index];
    if (!review || !imp || imp.status) return;
    const m = get().modeler;
    const names = m && imp.elementIds?.length ? imp.elementIds.map((id) => m.get<any>("elementRegistry").get(id)?.businessObject?.name).filter(Boolean) : [];
    const instruction =
      `Setze diesen Verbesserungsvorschlag im Prozess um: ${imp.title}. ${imp.description}` +
      (names.length ? ` Betroffene Elemente: ${names.map((n: string) => `„${n}“`).join(", ")}.` : "") +
      " Ändere nur, was dafür nötig ist.";
    const before = get().pending;
    await get().instruct(instruction, { shown: `💡 Vorschlag umsetzen: ${imp.title}`, llmOnly: true });
    // shown as a preview: marked as applied (discarding the preview restores the earlier review)
    const after = get().aiReview;
    if (get().pending && get().pending !== before && after?.improvements) {
      set({ aiReview: { ...after, improvements: after.improvements.map((x, i) => (i === index ? { ...x, status: "applied" as const } : x)) } });
    }
  },

  dismissImprovement: (index) => {
    const review = get().aiReview;
    if (!review?.improvements?.[index]) return;
    set({ aiReview: { ...review, improvements: review.improvements.map((x, i) => (i === index ? { ...x, status: "dismissed" as const } : x)) } });
  },

  instruct: async (text, opts = {}) => {
    const m = get().modeler;
    if (!m) return;
    const prevReview = get().aiReview;
    // Open questions survive an edit unless it answers them; the edit's own questions are added.
    const withOpenQuestions = (review: ai.ReviewReport): ai.ReviewReport => ({
      ...review,
      ambiguities: ai.mergeAmbiguities(prevReview?.ambiguities ?? [], opts.answered ?? [], review.ambiguities),
      // suggestions belong to the process, not to one edit: they stay until applied or dismissed
      ...(prevReview?.improvements?.length ? { improvements: prevReview.improvements } : {}),
    });
    set({ aiBusy: true, aiProgress: "KI-Dienst wird kontaktiert…", aiMessages: [...get().aiMessages, { role: "user", text: opts.shown ?? text }] });
    const say = (msg: string) => set({ aiMessages: [...get().aiMessages, { role: "assistant", text: msg }] });
    try {
      const prevXml = await getXml(m);
      const model = await getModelFromModeler(m);
      try {
        // AI edit: the LLM gets the whole current diagram and returns the updated one.
        const res = await ai.editViaLlm(model, text, {
          onProgress: (p) =>
            set({ aiProgress: p.phase === "thinking" ? "KI plant die Änderung…" : `KI schreibt das geänderte Modell… (${p.chars ?? 0} Zeichen)` }),
        });
        const nothing = !res.diff.added.length && !res.diff.removed.length && !res.diff.changed.length && !res.diff.flowsAdded && !res.diff.flowsRemoved;
        const notes = [
          ...res.review.ambiguities.map((a) => `Rückfrage: ${a.question}`),
          ...res.review.assumptions.map((a) => `Annahme: ${a}`),
          ...(res.review.findings ?? []).map((f) => `⚠ ${f}`),
        ];
        if (nothing) {
          await get().revalidate();
          set({ aiBusy: false, aiProgress: undefined, ...(opts.answered?.length && prevReview ? { aiReview: withOpenQuestions({ ...prevReview, ambiguities: res.review.ambiguities }) } : {}) });
          const answered = opts.answered?.length ? ` Keine Änderung am Diagramm nötig – ${opts.answered.length} Rückfrage(n) als beantwortet markiert.` : " Keine Änderung vorgenommen.";
          say(`KI-Modell:${answered}${notes.length ? "\n" + notes.join("\n") : ""}`);
          return;
        }
        await loadModelIntoModeler(m, res.model);
        highlight(m, res.diff.added, "ai-added");
        highlight(m, res.diff.changed, "ai-changed");
        await get().revalidate();
        set({
          aiBusy: false,
          aiProgress: undefined,
          aiReview: withOpenQuestions(res.review),
          pending: { prevXml, prevReview, description: `KI-Änderung: ${res.diff.summary}`, marked: [...res.diff.added, ...res.diff.changed] },
        });
        say(
          `KI-Modell: ${res.diff.summary}${notes.length ? "\n" + notes.join("\n") : ""}\nGrün = neu, orange = geändert. Vorschau – bitte übernehmen oder verwerfen.`,
        );
        return;
      } catch (err) {
        if (opts.llmOnly && err instanceof ai.LlmUnavailableError) {
          set({ aiBusy: false, aiProgress: undefined });
          say(`${(err as Error).message} Die Antworten wurden nicht übernommen – ohne KI lassen sie sich nicht einarbeiten.`);
          return;
        }
        if (!(err instanceof ai.LlmUnavailableError)) {
          set({ aiBusy: false, aiProgress: undefined });
          say(`KI-Änderung fehlgeschlagen: ${(err as Error).message} Das Diagramm ist unverändert.`);
          return;
        }
        // No AI available: fall back to the rule-based instruction parser, and say so.
        const res = ai.applyInstruction(model, text);
        if (res.applied) await loadModelIntoModeler(m, model);
        await get().revalidate();
        set({ aiBusy: false, aiProgress: undefined, pending: res.applied ? { prevXml, description: res.description } : get().pending });
        say(
          `${(err as Error).message} Stattdessen wurde der regelbasierte Offline-Parser verwendet – er versteht nur wenige feste Satzmuster.\n` +
            res.description +
            (res.assumptions.length ? `\nAnnahmen: ${res.assumptions.join("; ")}` : "") +
            (res.applied ? "\nVorschau – bitte übernehmen oder verwerfen." : ""),
        );
      }
    } catch (err) {
      set({ aiBusy: false, aiProgress: undefined });
      say(`Fehler: ${(err as Error).message}`);
    }
  },

  answerQuestions: async (answers) => {
    const given = answers.filter((a) => a.answer.trim());
    if (!given.length) return;
    const instruction = ai.buildAnswerInstruction(given);
    if (instruction.length > ai.MAX_INSTRUCTION_CHARS) {
      set({ aiMessages: [...get().aiMessages, { role: "assistant", text: `Antworten zu lang (${instruction.length} Zeichen, maximal ${ai.MAX_INSTRUCTION_CHARS}). Bitte kürzer fassen oder in zwei Durchgängen übergeben.` }] });
      return;
    }
    const shown = `Antworten auf ${given.length} Rückfrage(n):\n` + given.map((a) => `• ${a.question.question} → ${a.answer.trim()}`).join("\n");
    await get().instruct(instruction, { shown, answered: given.map((a) => a.question), llmOnly: true });
  },
}));

/** Open AI questions become open points of the process description. */
function clarifications(review?: ai.ReviewReport): string[] {
  return (review?.ambiguities ?? []).map((a) => `Klären: ${a.question}${a.options?.length ? ` (${a.options.join(" / ")})` : ""}`);
}

/** Colour new/changed elements while an AI change is shown as preview (markers are not saved). */
function highlight(m: Modeler, ids: string[], cls: string): void {
  const canvas = m.get<any>("canvas");
  const registry = m.get<any>("elementRegistry");
  for (const id of ids) if (registry.get(id)) canvas.addMarker(id, cls);
}

function unhighlight(m: Modeler, ids: string[]): void {
  const canvas = m.get<any>("canvas");
  const registry = m.get<any>("elementRegistry");
  for (const id of ids) {
    if (!registry.get(id)) continue;
    canvas.removeMarker(id, "ai-added");
    canvas.removeMarker(id, "ai-changed");
  }
}

// ---------------------------------------------------------------------------
// Autosave bookkeeping

const AUTOSAVE_MS = 1500;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Saves run strictly one after another: an autosave must never finish after a process switch it did not see. */
let saveQueue: Promise<void> = Promise.resolve();
function enqueueSave(task: () => Promise<void>): Promise<void> {
  saveQueue = saveQueue.then(task, task).catch(() => undefined);
  return saveQueue;
}
/** what was last written to (or read from) the library */
let lastSaved: { sig: string; xml: string } = { sig: "", xml: "" };

/** Everything that is saved with a process; equal signature = nothing to save. */
function signature(xml: string, s: { inputText: string; aiReview?: ai.ReviewReport; meta: ProcessMeta }): string {
  return `${xml}\u0000${s.inputText}\u0000${JSON.stringify(s.aiReview ?? null)}\u0000${JSON.stringify(s.meta)}`;
}

/** "released": the diagram on screen is the released one; "changed": released, then edited; "draft": never released. */
export function releaseState(s: { meta: ProcessMeta; diagramHash?: string }): "draft" | "released" | "changed" {
  if (!s.meta.release) return "draft";
  return s.diagramHash === s.meta.release.hash ? "released" : "changed";
}

export function releaseText(s: { meta: ProcessMeta; diagramHash?: string }): string {
  const r = s.meta.release;
  if (!r) return "Entwurf (noch nicht freigegeben)";
  const date = new Date(r.date).toLocaleDateString("de-CH");
  const base = `Version ${r.version} · freigegeben am ${date} durch ${r.by}`;
  return releaseState(s) === "released" ? base : `${base} – seither geändert (Entwurf)`;
}

function describeOpts(s: { aiReview?: ai.ReviewReport; meta: ProcessMeta; diagramHash?: string }) {
  return { extraOpenPoints: clarifications(s.aiReview), profile: s.meta, releaseText: releaseText(s) };
}

/**
 * The diagram as just loaded (start, "Neu", opened from the library) is the
 * saved baseline. Taken from bpmn-js itself: it re-serializes XML slightly
 * differently from the source, which must not count as a change.
 */
export async function markPristine(): Promise<void> {
  const s = useEditor.getState();
  if (!s.modeler) return;
  const xml = await getXml(s.modeler);
  lastSaved = { sig: signature(xml, s), xml };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  useEditor.setState({ saveState: "saved", saveError: undefined });
}


// Changes to the saved parts outside the diagram (AI review, accepted/rejected preview) trigger autosave too.
useEditor.subscribe((s, prev) => {
  if (s.aiReview !== prev.aiReview || s.pending !== prev.pending) s.noteChange();
});

function readFlag(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private mode: the setting lasts for this session only */
  }
}
