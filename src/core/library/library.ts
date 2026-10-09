/**
 * Process library: data format, backup file and merge rules. Storage itself
 * lives in the UI layer (IndexedDB); this part is pure so it can be tested.
 */

export interface StoredProcess {
  id: string;
  name: string;
  /** BPMN 2.0 XML incl. diagram */
  xml: string;
  /** text the process was generated from (AI input field) */
  sourceText: string;
  /** AI review incl. open questions, as JSON-safe data */
  review?: unknown;
  createdAt: string;
  updatedAt: string;
}

/** A saved version of a process (created by "In Bibliothek speichern"). */
export interface StoredVersion {
  id: string;
  processId: string;
  /** 1, 2, 3 … per process */
  number: number;
  createdAt: string;
  /** process name at that time */
  name: string;
  xml: string;
}

/** Versions kept per process; older ones are deleted. */
export const MAX_VERSIONS = 20;

export interface LibraryBackup {
  format: "flowcraft-library";
  version: 1;
  exportedAt: string;
  processes: StoredProcess[];
  /** optional (older backups have none) */
  versions?: StoredVersion[];
}

export function makeBackup(processes: StoredProcess[], now = new Date(), versions: StoredVersion[] = []): LibraryBackup {
  return { format: "flowcraft-library", version: 1, exportedAt: now.toISOString(), processes, versions };
}

/** Versions in a backup file (validated; the file itself is checked by parseBackup). */
export function parseBackupVersions(text: string): StoredVersion[] {
  const b = JSON.parse(text) as Partial<LibraryBackup>;
  const str = (v: unknown) => typeof v === "string";
  return (Array.isArray(b.versions) ? b.versions : []).filter(
    (v): v is StoredVersion => !!v && str(v.id) && str(v.processId) && typeof v.number === "number" && str(v.xml) && str(v.createdAt),
  );
}

/** Which versions to delete so that at most `max` remain (oldest go first). */
export function versionsToPrune(versions: StoredVersion[], max = MAX_VERSIONS): string[] {
  return [...versions].sort((a, b) => b.number - a.number).slice(max).map((v) => v.id);
}

/** Validate a backup file; throws a German message for the user. */
export function parseBackup(text: string): StoredProcess[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Die Datei ist keine FlowCraft-Sicherung (kein gültiges JSON).");
  }
  const b = data as Partial<LibraryBackup>;
  if (b?.format !== "flowcraft-library" || !Array.isArray(b.processes)) throw new Error("Die Datei ist keine FlowCraft-Sicherung.");
  if (b.version !== 1) throw new Error(`Sicherungsversion ${String(b.version)} wird nicht unterstützt.`);
  const str = (v: unknown) => typeof v === "string";
  return b.processes.filter(
    (p): p is StoredProcess => !!p && str(p.id) && str(p.name) && str(p.xml) && p.xml.includes("definitions") && str(p.updatedAt),
  ).map((p) => ({ ...p, sourceText: str(p.sourceText) ? p.sourceText : "", createdAt: str(p.createdAt) ? p.createdAt : p.updatedAt }));
}

export interface MergeResult {
  /** records to write */
  write: StoredProcess[];
  added: number;
  updated: number;
  /** already present in the same or a newer version */
  skipped: number;
}

/** Restore a backup into the library: new ids are added, same id keeps the newer version. */
export function mergeBackup(existing: StoredProcess[], incoming: StoredProcess[]): MergeResult {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const res: MergeResult = { write: [], added: 0, updated: 0, skipped: 0 };
  for (const p of incoming) {
    const cur = byId.get(p.id);
    if (!cur) res.added++;
    else if (p.updatedAt > cur.updatedAt) res.updated++;
    else {
      res.skipped++;
      continue;
    }
    res.write.push(p);
  }
  return res;
}

/** "Name", "Name (Kopie)", "Name (Kopie 2)", … not yet used in the library. */
export function copyName(name: string, taken: string[]): string {
  const base = name.replace(/ \(Kopie(?: \d+)?\)$/, "");
  const used = new Set(taken);
  if (!used.has(`${base} (Kopie)`)) return `${base} (Kopie)`;
  for (let i = 2; ; i++) if (!used.has(`${base} (Kopie ${i})`)) return `${base} (Kopie ${i})`;
}

export function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
