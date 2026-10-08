import type { StoredProcess } from "@core/library/library";

/**
 * Process library in the browser (IndexedDB). Data stays on this device and
 * this site address; the backup file is the way to move it elsewhere.
 */

const DB_NAME = "flowcraft";
const STORE = "processes";
const LAST_KEY = "flowcraft.lastProcess";

let dbPromise: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = undefined;
      reject(new Error("Die Prozessbibliothek ist in diesem Browser nicht verfügbar (privates Fenster oder gesperrter Speicher?)."));
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
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

export const deleteProcess = (id: string) => tx("readwrite", (s) => void s.delete(id));

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
