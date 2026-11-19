import { useEffect, useState } from "react";
import { releaseState, releaseText, useEditor } from "@state/store";
import { formatNext, messageText } from "@core/describe";
import { elementsForText, showElements } from "@ui/bpmn/locate";

const show = (ids: string[], text?: string) => {
  const m = useEditor.getState().modeler;
  if (m && !showElements(m, ids) && text) showElements(m, elementsForText(m, text));
};

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

  const meta = useEditor((s) => s.meta);
  const diagramHash = useEditor((s) => s.diagramHash);
  const [by, setBy] = useState(meta.release?.by ?? "");
  if (!d) return <p className="muted">Beschreibung wird erstellt…</p>;
  const state = releaseState({ meta, diagramHash });
  const setMeta = useEditor.getState().setMeta;
  const missing = [!meta.purpose.trim() && "Zweck", !meta.scope.trim() && "Geltungsbereich", !meta.owner.trim() && "Prozesseigner"].filter(Boolean);
  return (
    <div className="description">
      <section className="process-doc">
        <h4>Prozessdokument</h4>
        <p className="muted small">Kompakt: Zweck, Geltungsbereich, Prozesseigner und das Diagramm – der Ablauf steht im Diagramm.</p>
        <label className="meta-field">
          <span>Zweck</span>
          <textarea rows={2} value={meta.purpose} placeholder="Wozu dient der Prozess?" onChange={(e) => setMeta({ purpose: e.target.value })} />
        </label>
        <label className="meta-field">
          <span>Geltungsbereich</span>
          <input value={meta.scope} placeholder="Für wen / wo gilt er?" onChange={(e) => setMeta({ scope: e.target.value })} />
        </label>
        <label className="meta-field">
          <span>Prozesseigner</span>
          <input value={meta.owner} placeholder="Rolle oder Stelle, die verantwortlich ist" onChange={(e) => setMeta({ owner: e.target.value })} />
        </label>
        <div className={`release-state ${state}`}>{releaseText({ meta, diagramHash })}</div>
        <div className="row release-row">
          <input value={by} placeholder="Freigegeben durch (Name)" onChange={(e) => setBy(e.target.value)} aria-label="Freigegeben durch" />
          <button
            disabled={busy || !by.trim() || state === "released" || missing.length > 0}
            title={missing.length ? `Zuerst ausfüllen: ${missing.join(", ")}` : state === "released" ? "Dieser Stand ist bereits freigegeben" : "Speichert den Stand als neue Version und gibt ihn frei"}
            onClick={() => void useEditor.getState().releaseProcess(by)}
          >
            {meta.release ? `Version ${meta.release.version + (state === "released" ? 0 : 1)} freigeben` : "Freigeben"}
          </button>
        </div>
        <div className="row desc-actions">
          <button disabled={busy} onClick={() => useEditor.getState().exportProcessDocument("pdf")} title={state === "released" ? "" : "Noch nicht freigegeben: wird als ENTWURF gekennzeichnet"}>
            📄 Prozessdokument PDF
          </button>
          <button disabled={busy} onClick={() => useEditor.getState().exportProcessDocument("docx")} title={state === "released" ? "" : "Noch nicht freigegeben: wird als ENTWURF gekennzeichnet"}>
            📝 Prozessdokument Word
          </button>
        </div>
      </section>

      <h4>Ausführliche Beschreibung</h4>
      <div className="row desc-actions">
        <button disabled={busy} onClick={() => useEditor.getState().exportPdf()}>PDF (ausführlich)</button>
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
          <li key={s.id} className={`k-${s.kind} locatable`} onClick={() => show([s.id])} title="Im Diagramm zeigen">
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
              <li key={i} className="locatable" onClick={() => show([], p)} title="Im Diagramm zeigen">
                {p}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
