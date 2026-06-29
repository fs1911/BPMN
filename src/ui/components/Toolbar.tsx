import { useRef } from "react";
import { useEditor } from "@state/store";
import { summarize } from "@core/index";

export function Toolbar() {
  const store = useEditor;
  const theme = useEditor((s) => s.theme);
  const grid = useEditor((s) => s.grid);
  const snap = useEditor((s) => s.snap);
  const issues = useEditor((s) => s.issues);
  const fileRef = useRef<HTMLInputElement>(null);
  const counts = summarize(issues);

  const doExport = () => {
    const xml = store.getState().exportXml();
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "process.bpmn";
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        store.getState().importXml(String(reader.result));
      } catch (err) {
        alert("Import failed: " + (err as Error).message);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="toolbar">
      <span className="brand">FlowCraft<small> BPMN</small></span>
      <div className="tb-group">
        <button onClick={() => store.getState().undo()} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button onClick={() => store.getState().redo()} title="Redo (Ctrl+Y)">↷ Redo</button>
      </div>
      <div className="tb-group">
        <button onClick={() => store.getState().cleanupAll()} title="Auto layout + reroute">Clean up diagram</button>
        <button onClick={() => store.getState().cleanupFlows()} title="Reroute flows only">Clean up flows</button>
      </div>
      <div className="tb-group">
        <button onClick={() => store.getState().zoomBy(1.2)}>＋</button>
        <button onClick={() => store.getState().zoomBy(1 / 1.2)}>－</button>
        <button onClick={() => { store.getState().setZoom(1); store.getState().setPan({ x: 60, y: 60 }); }}>Reset view</button>
      </div>
      <div className="tb-group">
        <button className={grid ? "on" : ""} onClick={() => store.getState().toggleGrid()}>Grid</button>
        <button className={snap ? "on" : ""} onClick={() => store.getState().toggleSnap()}>Snap</button>
      </div>
      <div className="tb-group">
        <button onClick={() => fileRef.current?.click()}>Import</button>
        <button onClick={doExport}>Export BPMN</button>
        <input ref={fileRef} type="file" accept=".bpmn,.xml" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
      </div>
      <div className="tb-spacer" />
      <div className="tb-group validation-badge" title="Validation results">
        <span className="err">{counts.errors} errors</span>
        <span className="warn">{counts.warnings} warnings</span>
      </div>
      <button onClick={() => store.getState().toggleTheme()} title="Toggle theme">{theme === "light" ? "🌙" : "☀️"}</button>
    </div>
  );
}
