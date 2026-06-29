import { create } from "zustand";
import {
  BpmnModel,
  FlowElementType,
  History,
  ValidationIssue,
  autoLayout,
  cloneModel,
  createEdge,
  createNode,
  defaultSizeFor,
  emptyModel,
  rerouteOnly,
  routeMessageFlows,
  validate,
} from "@core/index";
import { exportBpmn, importBpmn } from "@core/xml";
import { ai } from "@core/index";

export type Theme = "light" | "dark";

export interface AiMessage {
  role: "user" | "assistant";
  text: string;
}

interface EditorState {
  model: BpmnModel;
  history: History;
  scope: string;
  selection: string[];
  zoom: number;
  pan: { x: number; y: number };
  theme: Theme;
  grid: boolean;
  snap: boolean;
  issues: ValidationIssue[];
  aiReview?: ai.ReviewReport;
  aiMessages: AiMessage[];
  aiBusy: boolean;
  connectFrom?: string;

  // selection
  select: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;

  // view
  setZoom: (z: number) => void;
  setPan: (p: { x: number; y: number }) => void;
  zoomBy: (factor: number, center?: { x: number; y: number }) => void;
  toggleTheme: () => void;
  toggleGrid: () => void;
  toggleSnap: () => void;

  // editing
  addNode: (type: FlowElementType, at: { x: number; y: number }) => string;
  moveSelection: (dx: number, dy: number, commit: boolean) => void;
  renameNode: (id: string, name: string) => void;
  setNodeName: (id: string, name: string) => void;
  connect: (source: string, target: string) => void;
  startConnect: (id?: string) => void;
  deleteSelection: () => void;

  // model lifecycle
  setModel: (m: BpmnModel, label: string) => void;
  revalidate: () => void;
  undo: () => void;
  redo: () => void;

  // cleanup
  cleanupAll: () => void;
  cleanupFlows: () => void;

  // io
  exportXml: () => string;
  importXml: (xml: string) => void;

  // ai
  generate: (text: string) => void;
  instruct: (text: string) => void;
}

function seedModel(): BpmnModel {
  const m = emptyModel({ processId: "Process_1", name: "New process" });
  const start = createNode(m, "startEvent", { name: "Start" });
  const task = createNode(m, "userTask", { name: "Handle request" });
  const end = createNode(m, "endEvent", { name: "Done" });
  createEdge(m, "sequenceFlow", start.id, task.id);
  createEdge(m, "sequenceFlow", task.id, end.id);
  autoLayout(m, m.rootProcessId);
  return m;
}

export const useEditor = create<EditorState>((set, get) => {
  const initial = seedModel();
  return {
    model: initial,
    history: new History(initial),
    scope: initial.rootProcessId,
    selection: [],
    zoom: 1,
    pan: { x: 40, y: 40 },
    theme: "light",
    grid: true,
    snap: true,
    issues: validate(initial),
    aiMessages: [],
    aiBusy: false,

    select: (ids, additive) =>
      set((s) => ({ selection: additive ? Array.from(new Set([...s.selection, ...ids])) : ids })),
    clearSelection: () => set({ selection: [], connectFrom: undefined }),

    setZoom: (z) => set({ zoom: Math.max(0.2, Math.min(4, z)) }),
    setPan: (p) => set({ pan: p }),
    zoomBy: (factor, center) =>
      set((s) => {
        const z = Math.max(0.2, Math.min(4, s.zoom * factor));
        if (!center) return { zoom: z };
        // zoom around a screen point
        const wx = (center.x - s.pan.x) / s.zoom;
        const wy = (center.y - s.pan.y) / s.zoom;
        return { zoom: z, pan: { x: center.x - wx * z, y: center.y - wy * z } };
      }),
    toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
    toggleGrid: () => set((s) => ({ grid: !s.grid })),
    toggleSnap: () => set((s) => ({ snap: !s.snap })),

    addNode: (type, at) => {
      const m = cloneModel(get().model);
      const size = defaultSizeFor(type);
      const snap = get().snap ? (v: number) => Math.round(v / 10) * 10 : (v: number) => v;
      const node = createNode(m, type, {
        parent: get().scope,
        bounds: { x: snap(at.x - size.width / 2), y: snap(at.y - size.height / 2), width: size.width, height: size.height },
        name: defaultName(type),
      });
      rerouteOnly(m, get().scope);
      get().setModel(m, `add ${type}`);
      set({ selection: [node.id] });
      return node.id;
    },

    moveSelection: (dx, dy, commit) => {
      const s = get();
      const m = cloneModel(s.model);
      const snap = s.snap ? (v: number) => Math.round(v / 10) * 10 : (v: number) => v;
      for (const id of s.selection) {
        const n = m.nodes[id];
        if (!n) continue;
        n.bounds.x = snap(n.bounds.x + dx);
        n.bounds.y = snap(n.bounds.y + dy);
      }
      rerouteOnly(m, s.scope);
      if (commit) {
        s.history.commit(m, "move", "move-" + s.selection.join(","));
        set({ model: m });
        get().revalidate();
      } else {
        set({ model: m });
      }
    },

    renameNode: (id, name) => {
      const m = cloneModel(get().model);
      if (m.nodes[id]) m.nodes[id].name = name;
      get().setModel(m, "rename");
    },
    setNodeName: (id, name) =>
      set((s) => {
        const m = cloneModel(s.model);
        if (m.nodes[id]) m.nodes[id].name = name;
        return { model: m };
      }),

    connect: (source, target) => {
      if (source === target) return;
      const m = cloneModel(get().model);
      const s = m.nodes[source];
      const t = m.nodes[target];
      if (!s || !t) return;
      const type = s.parent === t.parent ? "sequenceFlow" : "messageFlow";
      createEdge(m, type, source, target);
      rerouteOnly(m, get().scope);
      routeMessageFlows(m);
      get().setModel(m, "connect");
      set({ connectFrom: undefined });
    },
    startConnect: (id) => set({ connectFrom: id }),

    deleteSelection: () => {
      const s = get();
      if (!s.selection.length) return;
      const m = cloneModel(s.model);
      const sel = new Set(s.selection);
      for (const id of sel) {
        delete m.nodes[id];
        for (const lane of Object.values(m.lanes)) {
          lane.flowNodeRefs = lane.flowNodeRefs.filter((r) => r !== id);
        }
      }
      // drop edges touching deleted nodes
      for (const e of Object.values(m.edges)) {
        if (sel.has(e.id) || sel.has(e.source) || sel.has(e.target)) delete m.edges[e.id];
      }
      rerouteOnly(m, s.scope);
      get().setModel(m, "delete");
      set({ selection: [] });
    },

    setModel: (m, label) => {
      const s = get();
      s.history.commit(m, label);
      set({ model: m });
      get().revalidate();
    },
    revalidate: () => set({ issues: validate(get().model) }),

    undo: () => {
      const m = get().history.undo();
      if (m) {
        set({ model: m, selection: [] });
        get().revalidate();
      }
    },
    redo: () => {
      const m = get().history.redo();
      if (m) {
        set({ model: m, selection: [] });
        get().revalidate();
      }
    },

    cleanupAll: () => {
      const m = cloneModel(get().model);
      autoLayout(m, get().scope);
      get().setModel(m, "clean up diagram");
    },
    cleanupFlows: () => {
      const m = cloneModel(get().model);
      rerouteOnly(m, get().scope);
      get().setModel(m, "clean up flows");
    },

    exportXml: () => exportBpmn(get().model),
    importXml: (xml) => {
      const m = importBpmn(xml);
      // ensure geometry exists
      const hasGeom = Object.values(m.nodes).some((n) => n.bounds.x !== 0 || n.bounds.y !== 0);
      if (!hasGeom) autoLayout(m, m.rootProcessId);
      else routeMessageFlows(m);
      set({ model: m, scope: m.rootProcessId, selection: [], history: new History(m) });
      get().revalidate();
    },

    generate: (text) => {
      set({ aiBusy: true, aiMessages: [...get().aiMessages, { role: "user", text }] });
      try {
        const { model, review } = ai.generateFromTextSync(text);
        set({
          model,
          scope: model.rootProcessId,
          selection: [],
          history: new History(model),
          aiReview: review,
          aiBusy: false,
          aiMessages: [
            ...get().aiMessages,
            {
              role: "assistant",
              text: `Generated ${Object.keys(model.nodes).length} elements, ${review.roles.length} role(s), ${review.decisions.length} decision(s), ${review.loops.length} loop(s). Confidence ${(review.confidence * 100).toFixed(0)}%.`,
            },
          ],
        });
        get().revalidate();
      } catch (err) {
        set({
          aiBusy: false,
          aiMessages: [...get().aiMessages, { role: "assistant", text: `Generation failed: ${(err as Error).message}` }],
        });
      }
    },

    instruct: (text) => {
      const m = cloneModel(get().model);
      const res = ai.applyInstruction(m, text);
      const msgs: AiMessage[] = [
        ...get().aiMessages,
        { role: "user", text },
        { role: "assistant", text: res.description + (res.assumptions.length ? `\nAssumptions: ${res.assumptions.join("; ")}` : "") },
      ];
      if (res.applied) {
        get().setModel(m, "ai: " + text.slice(0, 24));
        set({ aiMessages: msgs });
      } else {
        set({ aiMessages: msgs });
      }
    },
  };
});

function defaultName(type: FlowElementType): string {
  if (type === "startEvent") return "Start";
  if (type === "endEvent") return "End";
  if (type.endsWith("Gateway")) return "Decision?";
  if (type === "userTask") return "User task";
  if (type === "serviceTask") return "Service task";
  if (type === "subProcess") return "Sub-process";
  if (type.endsWith("Task")) return "Task";
  return "";
}
