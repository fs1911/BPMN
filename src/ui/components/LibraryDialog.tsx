import { useEffect, useRef, useState } from "react";
import { useEditor } from "@state/store";
import { StoredProcess, copyName, makeBackup, mergeBackup, newId, parseBackup } from "@core/library/library";
import { deleteProcess, listProcesses, putProcess, putProcesses } from "@ui/library/db";
import { downloadBlob } from "@ui/export/pdf";

/** Process library: list, search, open, rename, duplicate, delete, backup/restore. */
export function LibraryDialog() {
  const open = useEditor((s) => s.libraryOpen);
  const version = useEditor((s) => s.libraryVersion);
  const currentId = useEditor((s) => s.doc.id);
  const [items, setItems] = useState<StoredProcess[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const store = useEditor.getState;

  useEffect(() => {
    if (!open) return;
    listProcesses()
      .then(setItems)
      .catch((err: Error) => setNote({ text: err.message, error: true }));
  }, [open, version]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;
  const close = () => {
    setEditing(undefined);
    setNote(undefined);
    store().setLibraryOpen(false);
  };
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      setNote({ text: (err as Error).message, error: true });
    }
  };
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((p) => p.name.toLowerCase().includes(q)) : items;

  const openOne = (id: string) =>
    run(async () => {
      await store().openProcess(id);
      close();
    });
  const rename = (p: StoredProcess, name: string) =>
    run(async () => {
      setEditing(undefined);
      if (!name.trim() || name.trim() === p.name) return;
      if (p.id === currentId) await store().renameCurrent(name);
      else await putProcess({ ...p, name: name.trim(), updatedAt: new Date().toISOString() });
      store().libraryChanged();
    });
  const duplicate = (p: StoredProcess) =>
    run(async () => {
      const now = new Date().toISOString();
      await putProcess({ ...p, id: newId(), name: copyName(p.name, items.map((i) => i.name)), createdAt: now, updatedAt: now });
      store().libraryChanged();
    });
  const remove = (p: StoredProcess) =>
    run(async () => {
      if (!window.confirm(`„${p.name}“ endgültig löschen?\n\nDas kann nicht rückgängig gemacht werden (ausser über eine Sicherungsdatei).`)) return;
      await deleteProcess(p.id);
      if (p.id === currentId) await store().newProcess({ skipSave: true });
      store().libraryChanged();
    });
  const newOne = () =>
    run(async () => {
      await store().newProcess();
      close();
    });
  const backup = () =>
    run(async () => {
      await store().saveNow();
      const all = await listProcesses();
      const day = new Date().toISOString().slice(0, 10);
      downloadBlob(new Blob([JSON.stringify(makeBackup(all))], { type: "application/json" }), `flowcraft-bibliothek-${day}.json`);
      setNote({ text: `${all.length} Prozess(e) in die Sicherungsdatei geschrieben.` });
    });
  const restore = (file: File | undefined) =>
    run(async () => {
      if (!file) return;
      const incoming = parseBackup(await file.text());
      const res = mergeBackup(await listProcesses(), incoming);
      await putProcesses(res.write);
      store().libraryChanged();
      setNote({ text: `Sicherung geladen: ${res.added} neu, ${res.updated} aktualisiert, ${res.skipped} bereits aktuell.` });
    });

  return (
    <div className="lib-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="lib-dialog" role="dialog" aria-label="Prozessbibliothek">
        <div className="lib-head">
          <h3>Prozessbibliothek</h3>
          <button className="lib-close" onClick={close} title="Schliessen (Esc)">✕</button>
        </div>
        <div className="lib-tools">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Prozess suchen…" autoFocus />
          <button onClick={() => void newOne()}>＋ Neuer Prozess</button>
        </div>

        <div className="lib-list">
          {items.length === 0 && <p className="muted lib-empty">Noch keine Prozesse gespeichert. Sobald du ein Diagramm bearbeitest oder generierst, wird es hier automatisch abgelegt.</p>}
          {items.length > 0 && shown.length === 0 && <p className="muted lib-empty">Kein Prozess passt zu „{query}“.</p>}
          {shown.map((p) => (
            <div key={p.id} className={`lib-row${p.id === currentId ? " current" : ""}`}>
              <div className="lib-main" onDoubleClick={() => void openOne(p.id)}>
                {editing?.id === p.id ? (
                  <input
                    className="lib-rename"
                    value={editing.name}
                    autoFocus
                    onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename(p, editing.name);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(undefined);
                      }
                    }}
                    onBlur={() => void rename(p, editing.name)}
                  />
                ) : (
                  <span className="lib-name">{p.name}{p.id === currentId && <em> · geöffnet</em>}</span>
                )}
                <span className="lib-date">{formatDate(p.updatedAt)}</span>
              </div>
              <div className="lib-actions">
                <button onClick={() => void openOne(p.id)} disabled={p.id === currentId}>Öffnen</button>
                <button onClick={() => setEditing({ id: p.id, name: p.name })} title="Umbenennen">Umbenennen</button>
                <button onClick={() => void duplicate(p)} title="Kopie anlegen">Duplizieren</button>
                <button className="danger" onClick={() => void remove(p)} title="Löschen">Löschen</button>
              </div>
            </div>
          ))}
        </div>

        {note && <p className={`lib-note${note.error ? " error" : ""}`}>{note.text}</p>}
        <div className="lib-foot">
          <span className="muted">Gespeichert nur in diesem Browser auf diesem Gerät. Regelmässig sichern – Browserdaten löschen oder eine neue Adresse heisst leere Bibliothek.</span>
          <div className="lib-foot-actions">
            <button onClick={() => void backup()}>Bibliothek sichern</button>
            <button onClick={() => fileRef.current?.click()}>Sicherung laden</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { void restore(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
