import { useEffect } from "react";
import { useEditor } from "@state/store";
import { formatNext, messageText } from "@core/describe";

/**
 * Live process description derived from the diagram (updates on every edit),
 * with PDF and Markdown export.
 */
export function DescriptionPanel() {
  const d = useEditor((s) => s.description);
  const busy = useEditor((s) => s.busy);
  useEffect(() => {
    void useEditor.getState().refreshDescription();
  }, []);

  if (!d) return <p className="muted">Beschreibung wird erstellt…</p>;
  return (
    <div className="description">
      <div className="row desc-actions">
        <button disabled={busy} onClick={() => useEditor.getState().exportPdf()}>PDF exportieren</button>
        <button onClick={() => useEditor.getState().exportMarkdown()}>Markdown</button>
      </div>
      <p className="muted small">Automatisch aus dem Diagramm erzeugt · aktualisiert sich bei jeder Änderung. Texte zu einzelnen Schritten im Eigenschaftenfeld „Dokumentation“ erfassen.</p>

      <h3>{d.title}</h3>
      <dl className="desc-header">
        {d.header.map((h) => (
          <div key={h.label}>
            <dt>{h.label}</dt>
            <dd className={h.value.startsWith("(") ? "muted" : ""}>{h.value}</dd>
          </div>
        ))}
        <div>
          <dt>Auslöser</dt>
          <dd>{d.triggers.join("; ") || "—"}</dd>
        </div>
        <div>
          <dt>Ergebnisse</dt>
          <dd>{d.outcomes.join("; ") || "—"}</dd>
        </div>
      </dl>

      <h4>Ablauf in Kürze</h4>
      <p>{d.summary}</p>
      {d.mainPath.length > 0 && (
        <p className="main-path">
          <b>Hauptablauf:</b> {d.mainPath.join(" → ")}
        </p>
      )}

      {d.roles.length > 0 && (
        <>
          <h4>Rollen und Aufgaben</h4>
          <ul className="desc-roles">
            {d.roles.map((r) => (
              <li key={r.name}>
                <b>{r.name}:</b> {r.steps.map((s) => `${s.no}. ${s.name}`).join(", ") || "—"}
              </li>
            ))}
          </ul>
        </>
      )}

      {d.partners.length > 0 && (
        <>
          <h4>Externe Partner</h4>
          <ul className="desc-roles">
            {d.partners.map((p) => (
              <li key={p.name}>
                <b>{p.name}:</b> {p.messages.map((m) => `${m.no}. ${m.direction === "out" ? "an" : "von"}: ${m.name || "Nachricht"}`).join(", ") || "—"}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Ablauf im Detail</h4>
      <ol className="desc-steps">
        {d.steps.map((s) => (
          <li key={s.id} className={`k-${s.kind}`}>
            <div className="step-head">
              <span className="no">{s.no}</span>
              <span className="name">{s.name}</span>
              <span className="type">{s.typeLabel}</span>
            </div>
            <div className="step-meta">
              {s.role !== "—" && <span>{s.role}</span>}
              <span>Weiter: {formatNext(s.next)}</span>
            </div>
            {s.description && <div className="step-desc">{s.description}</div>}
            {s.messages.length > 0 && <div className="step-desc">✉ {messageText(s)}</div>}
            {s.documentation && <div className="step-doc">{s.documentation}</div>}
          </li>
        ))}
      </ol>

      {d.openPoints.length > 0 && (
        <>
          <h4>Offene Punkte</h4>
          <ul className="desc-open">
            {d.openPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
