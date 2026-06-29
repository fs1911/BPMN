import { useEditor } from "@state/store";

export function ValidationPanel() {
  const issues = useEditor((s) => s.issues);
  const store = useEditor;
  if (!issues.length) return <div className="validation ok">✓ Keine Validierungsprobleme</div>;
  const SEV: Record<string, string> = { error: "Fehler", warning: "Warnung", info: "Info" };
  return (
    <div className="validation">
      <div className="validation-head">Validierung ({issues.length})</div>
      <ul>
        {issues.map((it, i) => (
          <li
            key={i}
            className={it.severity}
            onClick={() => it.elementId && store.getState().select([it.elementId])}
            title={it.rule}
          >
            <span className="sev">{SEV[it.severity] ?? it.severity}</span>
            {it.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
