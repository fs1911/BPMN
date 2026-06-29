import { useEffect } from "react";
import { useEditor } from "@state/store";
import { Toolbar } from "./components/Toolbar";
import { Palette } from "./components/Palette";
import { Canvas } from "./components/Canvas";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { AiPanel } from "./components/AiPanel";
import { ValidationPanel } from "./components/ValidationPanel";
import { useShortcuts } from "./hooks/useShortcuts";

export function App() {
  const theme = useEditor((s) => s.theme);
  useShortcuts();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      <Toolbar />
      <div className="workbench">
        <Palette />
        <main className="stage">
          <Canvas />
          <ValidationPanel />
        </main>
        <aside className="side">
          <PropertiesPanel />
          <AiPanel />
        </aside>
      </div>
    </div>
  );
}
