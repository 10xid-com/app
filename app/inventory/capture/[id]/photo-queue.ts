/**
 * Photos waiting to be sent, kept on the phone until the portal has them.
 *
 * A basement pantry has no signal and a phone locks itself: a photo taken and
 * not yet sent must survive both. Each one is put in IndexedDB the moment it
 * is ready, and taken out only when the portal has answered that it is
 * stored. Reopening the item's page sends whatever is still here.
 *
 * Where IndexedDB is not available, or refuses a write (some private windows,
 * a full disk), the queue lives in memory for as long as the page is open:
 * the photo is still retried, but it will not survive a reload — so keep()
 * says whether it really kept the photo, and the screen tells the person to
 * keep the page open. Browser-only; every call is wrapped so a storage
 * failure is never an exception.
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

/** Keep a photo until it is sent. True when it is on the phone (IndexedDB); false when only this page holds it. */
export async function keep(photo: QueuedPhoto): Promise<boolean> {
  memory.set(photo.key, photo);
  return (await inStore("readwrite", (s) => s.put(photo))) !== null;
}

/** Whether this browser lets the queue outlive the page at all. */
export async function queuePersists(): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  db.close();
  return true;
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
 * before its photos arrive would be saved without that evidence. Null until
 * the page has looked in the phone's queue: a reload must not offer Save in
 * the moment before the photos still waiting there are found. (The portal
 * refuses to save an item whose photos have not arrived anyway; this is so
 * the screen does not offer it.)
 */
const outstanding = new Map<string, number | null>();
const listeners = new Set<() => void>();

export function setOutstanding(captureId: string, count: number | null): void {
  if (outstanding.has(captureId) && outstanding.get(captureId) === count) return;
  outstanding.set(captureId, count);
  for (const listener of listeners) listener();
}

export function outstandingFor(captureId: string): number | null {
  return outstanding.has(captureId) ? outstanding.get(captureId)! : null;
}

export function subscribeOutstanding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ */
/* What the portal's answer to an upload means for the photo           */
/* ------------------------------------------------------------------ */

export type Sent =
  | { ok: true; documentId: string; note: string | null }
  | {
      ok: false;
      /** Keep it on the phone for a later try (else it is dropped, with the reason). */
      keep: boolean;
      /** Try again on its own after a pause (else when the page or the connection comes back). */
      retry: boolean;
      message: string;
    };

export type UploadAnswer = {
  documentId?: string;
  error?: string;
  code?: string;
  evidenceFor?: { productName: string }[];
};

/**
 * The portal's answer to one upload → keep, retry or drop. A photo is dropped
 * only when it can never be accepted (not a photo, too large, empty); a stale
 * page, a sign-out, or an item saved or discarded meanwhile keeps it on the
 * phone, for the person to decide on its page.
 */
export function uploadOutcome(status: number, body: UploadAnswer): Sent {
  if (status >= 200 && status < 300 && body.documentId) {
    const already = body.evidenceFor?.[0]?.productName;
    return { ok: true, documentId: body.documentId, note: already ? `This photo is already saved with ${already}.` : null };
  }
  if (status === 401) {
    return { ok: false, keep: true, retry: false, message: "You were signed out. Sign in again and reopen this item: the photo is kept and will be sent." };
  }
  // A sign-in in another tab, or a switch of business, leaves this page out of
  // date (its CSRF token, its business): not a reason to lose the photo.
  if (status === 403 || status === 404) {
    return { ok: false, keep: true, retry: false, message: "This page is out of date. Reload it: the photo is kept and will be sent." };
  }
  if (status === 409) {
    return {
      ok: false,
      keep: true,
      retry: false,
      message:
        body.code === "saved"
          ? "This item was saved before this photo arrived. Reload: it can be added to the saved item."
          : "This item was discarded. Reload to decide what to do with this photo.",
    };
  }
  if (status >= 500 || status === 408 || status === 429 || status === 422) {
    return { ok: false, keep: true, retry: true, message: body.error ?? "Not sent yet. It will be tried again." };
  }
  return { ok: false, keep: false, retry: false, message: body.error ?? `That photo was refused (${status}).` };
}

/** Send one kept photo; `afterSave` adds it to an item already saved. */
export async function sendPhoto(photo: QueuedPhoto, csrfHeader: string, csrf: string, afterSave = false): Promise<Sent> {
  const form = new FormData();
  form.append("photo", photo.blob, photo.fileName);
  form.append("sha256", photo.sha256);
  if (photo.capturedAt) form.append("capturedAt", String(photo.capturedAt));
  if (afterSave) form.append("afterSave", "1");
  let res: Response;
  try {
    res = await fetch(`/api/inventory/captures/${photo.captureId}/photos`, {
      method: "POST",
      headers: { [csrfHeader]: csrf },
      body: form,
    });
  } catch {
    return { ok: false, keep: true, retry: true, message: "Not sent yet: no connection. It is sent when the connection is back." };
  }
  return uploadOutcome(res.status, (await res.json().catch(() => ({}))) as UploadAnswer);
}

