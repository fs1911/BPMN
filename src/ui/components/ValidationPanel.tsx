import { useEditor } from "@state/store";

export function ValidationPanel() {
  const issues = useEditor((s) => s.issues);
  const store = useEditor;
  if (!issues.length) return <div className="validation ok">✓ No validation issues</div>;
  return (
    <div className="validation">
      <div className="validation-head">Validation ({issues.length})</div>
      <ul>
        {issues.map((it, i) => (
          <li
            key={i}
            className={it.severity}
            onClick={() => it.elementId && store.getState().select([it.elementId])}
            title={it.rule}
          >
            <span className="sev">{it.severity}</span>
            {it.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
