/**
 * Photos waiting to be sent, kept on the phone until the portal has them.
 *
 * A basement pantry has no signal and a phone locks itself: a photo taken and
 * not yet sent must survive both. Each one is put in IndexedDB the moment it
 * is ready, and taken out only when the portal has answered that it is
 * stored. Reopening the item's page sends whatever is still here.
 *
 * Where IndexedDB is not available (some private windows, a full disk), the
 * queue lives in memory for as long as the page is open, and the screen says
 * nothing different: the photo is still retried, it just will not survive a
 * reload. Browser-only; every call is wrapped so a storage failure is never an
 * error the person sees.
 */

export type QueuedPhoto = {
  key: string;
  captureId: string;
  blob: Blob;
  fileName: string;
  /** The SHA-256 of `blob`, hex — the portal checks it. */
  sha256: string;
  /** When the photo was taken, as the file says (ms since 1970), or null. */
  capturedAt: number | null;
  addedAt: number;
};

const DB_NAME = "10xid-inventory";
const STORE = "photo-uploads";
const memory = new Map<string, QueuedPhoto>();

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const request = work(tx.objectStore(STORE));
          tx.oncomplete = () => {
            db.close();
            resolve(request.result);
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            resolve(null);
          };
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

export async function keep(photo: QueuedPhoto): Promise<void> {
  memory.set(photo.key, photo);
  await inStore("readwrite", (s) => s.put(photo));
}

export async function forget(key: string): Promise<void> {
  memory.delete(key);
  await inStore("readwrite", (s) => s.delete(key));
}

/** Everything still waiting for this capture, oldest first. */
export async function waitingFor(captureId: string): Promise<QueuedPhoto[]> {
  const stored = (await inStore("readonly", (s) => s.getAll() as IDBRequest<QueuedPhoto[]>)) ?? [];
  const byKey = new Map<string, QueuedPhoto>();
  for (const p of [...stored, ...memory.values()]) if (p.captureId === captureId) byKey.set(p.key, p);
  return [...byKey.values()].sort((a, b) => a.addedAt - b.addedAt);
}

/** Drop what is kept for a capture that can take no more photos (saved or discarded). */
export async function forgetCapture(captureId: string): Promise<void> {
  for (const p of await waitingFor(captureId)) await forget(p.key);
}

/*
 * How many of a capture's photos are not with the portal yet — being
 * prepared, waiting or sending — so Save can wait for them: an item saved
 * before its photos arrive would be saved without that evidence.
 */
const outstanding = new Map<string, number>();
const listeners = new Set<() => void>();

export function setOutstanding(captureId: string, count: number): void {
  if ((outstanding.get(captureId) ?? 0) === count) return;
  outstanding.set(captureId, count);
  for (const listener of listeners) listener();
}

export function outstandingFor(captureId: string): number {
  return outstanding.get(captureId) ?? 0;
}

export function subscribeOutstanding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
