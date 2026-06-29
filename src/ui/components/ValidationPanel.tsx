import { useState } from "react";
import { useEditor } from "@state/store";
import { summarize } from "@core/index";

const SEV_LABEL: Record<string, string> = { error: "Fehler", warning: "Hinweis", info: "Tipp" };
const SEV_ICON: Record<string, string> = { error: "✕", warning: "!", info: "i" };

export function ValidationPanel() {
  const issues = useEditor((s) => s.issues);
  const store = useEditor;
  const [open, setOpen] = useState(true);
  const counts = summarize(issues);

  const locate = (elementId?: string) => {
    if (!elementId) return;
    const modeler = store.getState().modeler;
    if (!modeler) return;
    const el = modeler.get<any>("elementRegistry").get(elementId);
    if (!el) return;
    modeler.get<any>("selection").select(el);
    try {
      modeler.get<any>("canvas").scrollToElement(el);
    } catch {
      /* older bpmn-js */
    }
  };

  if (!issues.length) {
    return <div className="validation ok">✓ Alles sauber – keine Probleme im Diagramm</div>;
  }

  return (
    <div className={`validation ${open ? "open" : "collapsed"}`}>
      <div className="validation-head" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"} Diagramm-Prüfung</span>
        <span className="vh-counts">
          {counts.errors > 0 && <span className="b err">{counts.errors} Fehler</span>}
          {counts.warnings > 0 && <span className="b warn">{counts.warnings} Hinweise</span>}
          {counts.infos > 0 && <span className="b info">{counts.infos} Tipps</span>}
        </span>
      </div>
      {open && (
        <ul>
          {issues.map((it, i) => (
            <li key={i} className={it.severity} onClick={() => locate(it.elementId)}>
              <span className={`badge ${it.severity}`}>{SEV_ICON[it.severity]}</span>
              <div className="vi-body">
                <div className="vi-msg">
                  <span className="vi-sev">{SEV_LABEL[it.severity] ?? it.severity}:</span> {it.message}
                </div>
                {it.hint && <div className="vi-hint">→ {it.hint}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
