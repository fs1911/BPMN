import { useEffect } from "react";
import { useEditor } from "@state/store";

/** Global keyboard shortcuts. Ignored while typing in inputs. */
export function useShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const s = useEditor.getState();
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        s.redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        s.deleteSelection();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.select(Object.keys(s.model.nodes).filter((id) => s.model.nodes[id].parent === s.scope));
      } else if (e.key === "Escape") {
        s.clearSelection();
      } else if (e.key === "l" && !mod) {
        s.cleanupAll();
      } else if (e.key === "=" || e.key === "+") {
        s.zoomBy(1.2);
      } else if (e.key === "-") {
        s.zoomBy(1 / 1.2);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
