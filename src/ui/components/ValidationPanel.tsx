import { useEditor } from "@state/store";

export function ValidationPanel() {
  const issues = useEditor((s) => s.issues);
  const store = useEditor;

  const locate = (elementId?: string) => {
    if (!elementId) return;
    const modeler = store.getState().modeler;
    if (!modeler) return;
    const registry = modeler.get<any>("elementRegistry");
    const selection = modeler.get<any>("selection");
    const canvas = modeler.get<any>("canvas");
    const el = registry.get(elementId);
    if (el) {
      selection.select(el);
      try {
        canvas.scrollToElement(el);
      } catch {
        /* older bpmn-js */
      }
    }
  };

  if (!issues.length) return <div className="validation ok">✓ Keine Validierungsprobleme</div>;
  const SEV: Record<string, string> = { error: "Fehler", warning: "Warnung", info: "Info" };
  return (
    <div className="validation">
      <div className="validation-head">Validierung ({issues.length})</div>
      <ul>
        {issues.map((it, i) => (
          <li key={i} className={it.severity} onClick={() => locate(it.elementId)} title={it.rule}>
            <span className="sev">{SEV[it.severity] ?? it.severity}</span>
            {it.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
