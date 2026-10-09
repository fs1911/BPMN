import { useEffect, useRef, useState } from "react";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { useEditor } from "@state/store";
import { diffModels, importBpmn, type ModelDiff } from "@core/index";
import { MAX_VERSIONS, type StoredVersion } from "@core/library/library";
import { listVersions } from "@ui/library/db";
import { getXml } from "@ui/bpmn/bridge";

/**
 * Version history of the open process: every "In Bibliothek speichern" adds a
 * version (at most 20 kept). A version can be set side by side with the
 * current state (removed red, new green, changed orange) and restored.
 */
export function VersionsDialog() {
  const open = useEditor((s) => s.versionsOpen);
  const docId = useEditor((s) => s.doc.id);
  const docName = useEditor((s) => s.doc.name);
  const version = useEditor((s) => s.libraryVersion);
  const [items, setItems] = useState<StoredVersion[]>();
  const [compare, setCompare] = useState<StoredVersion>();
  const [error, setError] = useState<string>();
  const store = useEditor.getState;

  useEffect(() => {
    if (!open || !docId) return;
    setItems(undefined);
    listVersions(docId)
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, [open, docId, version]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (compare) setCompare(undefined);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;
  const close = () => {
    setCompare(undefined);
    setError(undefined);
    store().setVersionsOpen(false);
  };
  const restore = async (v: StoredVersion) => {
    if (!window.confirm(`Version ${v.number} vom ${formatDate(v.createdAt)} wiederherstellen?\n\nDer aktuelle Stand wird vorher als neueste Version gesichert und bleibt so erhalten.`)) return;
    close();
    await store().restoreVersion(v.xml, v.number);
  };

  if (compare) return <CompareView version={compare} onBack={() => setCompare(undefined)} onRestore={() => void restore(compare)} />;

  return (
    <div className="lib-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="lib-dialog" role="dialog" aria-label="Versionsverlauf">
        <div className="lib-head">
          <h3>Versionsverlauf · {docName}</h3>
          <button className="lib-close" onClick={close} title="Schliessen (Esc)">✕</button>
        </div>
        <div className="lib-list">
          {!docId && <p className="muted lib-empty">Dieser Prozess ist noch nicht in der Bibliothek. Mit „💾 In Bibliothek speichern“ entsteht die erste Version.</p>}
          {docId && items?.length === 0 && <p className="muted lib-empty">Noch keine Versionen. Jeder Klick auf „💾 In Bibliothek speichern“ legt eine Version an.</p>}
          {items?.map((v, i) => (
            <div key={v.id} className="lib-row">
              <div className="lib-main">
                <span className="lib-name">Version {v.number}{i === 0 && <em> · neueste</em>}</span>
                <span className="lib-date">{formatDate(v.createdAt)}{v.name !== docName ? ` · damals „${v.name}“` : ""}</span>
              </div>
              <div className="lib-actions">
                <button onClick={() => setCompare(v)}>Mit aktuellem Stand vergleichen</button>
                <button onClick={() => void restore(v)}>Wiederherstellen</button>
              </div>
            </div>
          ))}
        </div>
        {error && <p className="lib-note error">{error}</p>}
        <div className="lib-foot">
          <span className="muted">Eine Version entsteht bei jedem Klick auf „💾 In Bibliothek speichern“ (Strg+S). Die letzten {MAX_VERSIONS} Versionen pro Prozess bleiben erhalten.</span>
        </div>
      </div>
    </div>
  );
}

/** Saved version (left) and current state (right) side by side, differences marked. */
function CompareView({ version, onBack, onRestore }: { version: StoredVersion; onBack: () => void; onRestore: () => void }) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<ModelDiff>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const m = useEditor.getState().modeler;
    if (!m || !leftRef.current || !rightRef.current) return;
    const left = new NavigatedViewer({ container: leftRef.current });
    const right = new NavigatedViewer({ container: rightRef.current });
    let alive = true;
    (async () => {
      const current = await getXml(m);
      const d = diffModels(importBpmn(version.xml), importBpmn(current));
      await left.importXML(version.xml);
      await right.importXML(current);
      if (!alive) return;
      const mark = (viewer: NavigatedViewer, ids: string[], cls: string) => {
        const registry = viewer.get<any>("elementRegistry");
        const canvas = viewer.get<any>("canvas");
        for (const id of ids) if (registry.get(id)) canvas.addMarker(id, cls);
      };
      const changed = d.changed.map((c) => c.id);
      mark(left, d.removed, "diff-removed");
      mark(left, changed, "diff-changed");
      mark(right, d.added, "diff-added");
      mark(right, changed, "diff-changed");
      for (const v of [left, right]) v.get<any>("canvas").zoom("fit-viewport", "auto");
      setDiff(d);
    })().catch((e: Error) => setError(`Vergleich nicht möglich: ${e.message}`));
    return () => {
      alive = false;
      left.destroy();
      right.destroy();
    };
  }, [version]);

  return (
    <div className="cmp-overlay" role="dialog" aria-label="Versionsvergleich">
      <div className="cmp-head">
        <button onClick={onBack}>← Zurück zur Liste</button>
        <h3>Version {version.number} ({formatDate(version.createdAt)}) ↔ aktueller Stand</h3>
        <span className="cmp-legend">
          <i className="lg removed" /> entfernt <i className="lg added" /> neu <i className="lg changed" /> geändert
        </span>
        <button className="cmp-restore" onClick={onRestore}>Version {version.number} wiederherstellen</button>
      </div>
      <div className="cmp-body">
        <div className="cmp-pane">
          <div className="cmp-title">Version {version.number}</div>
          <div ref={leftRef} className="cmp-canvas" />
        </div>
        <div className="cmp-pane">
          <div className="cmp-title">Aktueller Stand</div>
          <div ref={rightRef} className="cmp-canvas" />
        </div>
      </div>
      <div className="cmp-changes">
        {error && <p className="error">{error}</p>}
        {!diff && !error && <p className="muted">Vergleiche …</p>}
        {diff && diff.lines.length === 0 && <p className="muted">Keine inhaltlichen Unterschiede (höchstens Anordnung oder Linienführung).</p>}
        {diff && diff.lines.length > 0 && (
          <>
            <strong>{diff.lines.length} Änderung(en):</strong>
            <ul>
              {diff.lines.map((l, i) => (
                <li key={i} className={l.startsWith("Neu") ? "added" : l.startsWith("Entfernt") || l.startsWith("Bahn entfernt") ? "removed" : "changed"}>
                  {l}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
