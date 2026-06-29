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
        alert("Import fehlgeschlagen: " + (err as Error).message);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="toolbar">
      <span className="brand">FlowCraft<small> BPMN</small></span>
      <div className="tb-group">
        <button onClick={() => store.getState().undo()} title="Rückgängig (Strg+Z)">↶ Rückgängig</button>
        <button onClick={() => store.getState().redo()} title="Wiederholen (Strg+Y)">↷ Wiederholen</button>
      </div>
      <div className="tb-group">
        <button onClick={() => store.getState().cleanupAll()} title="Auto-Layout + Kanten neu verlegen">Diagramm aufräumen</button>
        <button onClick={() => store.getState().cleanupFlows()} title="Nur Kanten neu verlegen">Kanten aufräumen</button>
      </div>
      <div className="tb-group">
        <button onClick={() => store.getState().zoomBy(1.2)} title="Vergrößern">＋</button>
        <button onClick={() => store.getState().zoomBy(1 / 1.2)} title="Verkleinern">－</button>
        <button onClick={() => { store.getState().setZoom(1); store.getState().setPan({ x: 60, y: 60 }); }}>Ansicht zurücksetzen</button>
      </div>
      <div className="tb-group">
        <button className={grid ? "on" : ""} onClick={() => store.getState().toggleGrid()}>Raster</button>
        <button className={snap ? "on" : ""} onClick={() => store.getState().toggleSnap()}>Einrasten</button>
      </div>
      <div className="tb-group">
        <button onClick={() => fileRef.current?.click()}>Importieren</button>
        <button onClick={doExport}>BPMN exportieren</button>
        <input ref={fileRef} type="file" accept=".bpmn,.xml" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
      </div>
      <div className="tb-spacer" />
      <div className="tb-group validation-badge" title="Validierungsergebnisse">
        <span className="err">{counts.errors} Fehler</span>
        <span className="warn">{counts.warnings} Warnungen</span>
      </div>
      <button onClick={() => store.getState().toggleTheme()} title="Design wechseln">{theme === "light" ? "🌙" : "☀️"}</button>
    </div>
  );
}
