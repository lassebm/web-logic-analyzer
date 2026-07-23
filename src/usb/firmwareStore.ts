// User-supplied custom firmware (.fw) intake + IndexedDB cache. This is the
// optional override; the default firmware is bundled (see src/firmware/).

const DB_NAME = "web-logic-analyzer";
const DB_VERSION = 1;
const STORE = "firmware";
const KEY = "current";

export interface StoredFirmware {
  name: string;
  size: number;
  data: ArrayBuffer;
}

/**
 * Cap on a custom firmware file. Real fx2lafw images are a few KB (the FX2 has
 * only 16 KB of RAM), so anything far larger is a mistake or an attempt to OOM
 * the tab / wedge the IndexedDB quota. Checked before the file is read.
 */
export const MAX_FIRMWARE_BYTES = 256 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          reject(req.error);
          db.close();
        };
      }),
  );
}

/** Persist a user-selected firmware file so it survives reloads. */
export async function saveFirmware(file: File): Promise<StoredFirmware> {
  if (file.size === 0) throw new Error("Firmware file is empty.");
  if (file.size > MAX_FIRMWARE_BYTES) {
    throw new Error(
      `Firmware file is ${file.size} bytes; the limit is ${MAX_FIRMWARE_BYTES}.`,
    );
  }
  const data = await file.arrayBuffer();
  const record: StoredFirmware = {
    name: file.name,
    size: data.byteLength,
    data,
  };
  await tx("readwrite", (s) => s.put(record, KEY));
  return record;
}

/** Load the cached firmware, or null if the user hasn't supplied one yet. */
export async function loadFirmware(): Promise<StoredFirmware | null> {
  try {
    const record = await tx<StoredFirmware | undefined>("readonly", (s) =>
      s.get(KEY),
    );
    return record ?? null;
  } catch {
    return null;
  }
}

/** Forget the cached firmware. */
export async function clearFirmware(): Promise<void> {
  await tx("readwrite", (s) => s.delete(KEY));
}
