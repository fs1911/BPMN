import { useEffect } from "react";
import { useEditor } from "@state/store";
import { Toolbar } from "./components/Toolbar";
import { Canvas } from "./components/Canvas";
import { AiPanel } from "./components/AiPanel";
import { ValidationPanel } from "./components/ValidationPanel";
import { PreviewBar } from "./components/PreviewBar";
import { LibraryDialog } from "./components/LibraryDialog";

export function App() {
  const theme = useEditor((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    // Warn before unsaved work is lost; save right away when the tab is hidden.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState();
      if (s.saveState !== "saved") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") void useEditor.getState().saveNow();
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="workbench">
        <main className="stage">
          <Canvas />
          <PreviewBar />
          <ValidationPanel />
        </main>
        <aside className="side">
          <AiPanel />
        </aside>
      </div>
      <LibraryDialog />
    </div>
  );
}
