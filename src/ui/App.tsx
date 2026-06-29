import { useEffect } from "react";
import { useEditor } from "@state/store";
import { Toolbar } from "./components/Toolbar";
import { Canvas } from "./components/Canvas";
import { AiPanel } from "./components/AiPanel";
import { ValidationPanel } from "./components/ValidationPanel";

export function App() {
  const theme = useEditor((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      <Toolbar />
      <div className="workbench">
        <main className="stage">
          <Canvas />
          <ValidationPanel />
        </main>
        <aside className="side">
          <AiPanel />
        </aside>
      </div>
    </div>
  );
}
