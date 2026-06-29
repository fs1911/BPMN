import { useRef } from "react";
import { useEditor } from "@state/store";
import { summarize } from "@core/index";

export function Toolbar() {
  const store = useEditor;
  const theme = useEditor((s) => s.theme);
  const issues = useEditor((s) => s.issues);
  const busy = useEditor((s) => s.busy);
  const fileRef = useRef<HTMLInputElement>(null);
  const counts = summarize(issues);

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      store.getState().importXml(String(reader.result)).catch((err) => alert("Import fehlgeschlagen: " + err.message));
    };
    reader.readAsText(file);
  };

  return (
    <div className="toolbar">
      <span className="brand">FlowCraft<small> BPMN</small></span>
      <div className="tb-group">
        <button onClick={() => store.getState().undo()} title="Rückgängig (Strg+Z)">↶</button>
        <button onClick={() => store.getState().redo()} title="Wiederholen (Strg+Y)">↷</button>
      </div>
      <div className="tb-group">
        <button disabled={busy} onClick={() => store.getState().cleanupAll()} title="Auto-Layout + Kanten neu verlegen (FlowCraft-Engine)">
          {busy ? "…" : "Diagramm aufräumen"}
        </button>
        <button disabled={busy} onClick={() => store.getState().cleanupFlowsOnly()} title="Nur Kanten neu verlegen">Kanten aufräumen</button>
      </div>
      <div className="tb-group">
        <button onClick={() => store.getState().zoomIn()} title="Vergrößern">＋</button>
        <button onClick={() => store.getState().zoomOut()} title="Verkleinern">－</button>
        <button onClick={() => store.getState().fit()} title="Einpassen">Einpassen</button>
      </div>
      <div className="tb-group">
        <button onClick={() => fileRef.current?.click()}>Importieren</button>
        <button onClick={() => store.getState().exportXml()}>BPMN exportieren</button>
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
