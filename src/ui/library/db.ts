import { MAX_VERSIONS, type StoredProcess, type StoredVersion, versionsToPrune } from "@core/library/library";

/**
 * Process library in the browser (IndexedDB). Data stays on this device and
 * this site address; the backup file is the way to move it elsewhere.
 */

const DB_NAME = "flowcraft";
const STORE = "processes";
const VERSIONS = "versions";
const LAST_KEY = "flowcraft.lastProcess";

let dbPromise: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    // v1: processes; v2: + versions (existing processes are kept)
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(VERSIONS)) d.createObjectStore(VERSIONS, { keyPath: "id" }).createIndex("processId", "processId");
    };
    req.onsuccess = () => {
      // Another tab upgrades the database: let go so it can (this tab reopens on next use).
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = undefined;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = undefined;
      reject(new Error("Die Prozessbibliothek ist in diesem Browser nicht verfügbar (privates Fenster oder gesperrter Speicher?)."));
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void, storeName = STORE): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const req = run(t.objectStore(storeName));
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = () => reject(t.error ?? new Error("Speichern fehlgeschlagen."));
    t.onabort = () => reject(t.error ?? new Error("Speichern abgebrochen (Speicher voll?)."));
  });
}

export const listProcesses = async (): Promise<StoredProcess[]> =>
  ((await tx<StoredProcess[]>("readonly", (s) => s.getAll())) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const getProcess = (id: string) => tx<StoredProcess | undefined>("readonly", (s) => s.get(id));

export const putProcess = (p: StoredProcess) => tx("readwrite", (s) => void s.put(p));

export const putProcesses = (ps: StoredProcess[]) =>
  tx("readwrite", (s) => {
    for (const p of ps) s.put(p);
  });

export async function deleteProcess(id: string): Promise<void> {
  await tx("readwrite", (s) => void s.delete(id));
  const ids = (await listVersions(id)).map((v) => v.id);
  if (ids.length) await tx("readwrite", (s) => ids.forEach((v) => s.delete(v)), VERSIONS);
}

// --- Versions -------------------------------------------------------------

/** Versions of one process, newest first. */
export const listVersions = async (processId: string): Promise<StoredVersion[]> =>
  ((await tx<StoredVersion[]>("readonly", (s) => s.index("processId").getAll(processId), VERSIONS)) ?? []).sort((a, b) => b.number - a.number);

export const listAllVersions = async (): Promise<StoredVersion[]> => (await tx<StoredVersion[]>("readonly", (s) => s.getAll(), VERSIONS)) ?? [];

export const putVersions = (vs: StoredVersion[]) => tx("readwrite", (s) => vs.forEach((v) => s.put(v)), VERSIONS);

/**
 * Store a new version of a process unless it equals the latest one, then keep
 * only the newest MAX_VERSIONS. Returns the version number (new or existing).
 */
export async function addVersion(processId: string, name: string, xml: string, now = new Date()): Promise<{ number: number; created: boolean }> {
  const existing = await listVersions(processId);
  if (existing[0]?.xml === xml) return { number: existing[0].number, created: false };
  const number = (existing[0]?.number ?? 0) + 1;
  const v: StoredVersion = { id: `${processId}_v${number}_${now.getTime().toString(36)}`, processId, number, createdAt: now.toISOString(), name, xml };
  const prune = versionsToPrune([v, ...existing], MAX_VERSIONS);
  await tx(
    "readwrite",
    (s) => {
      s.put(v);
      for (const id of prune) s.delete(id);
    },
    VERSIONS,
  );
  return { number, created: true };
}

/** Ask the browser not to evict the library under storage pressure. */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
}

export function getLastOpened(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setLastOpened(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* not remembered */
  }
}
