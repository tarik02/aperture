import { decodeStructuredCloneAsync } from "@aperture/browser-state";
import type { StorageOrigin } from "../schema.js";

type DatabaseState = NonNullable<StorageOrigin["indexedDB"]>[number];
type KeyPathState = DatabaseState["objectStores"][number]["keyPath"];

interface RestoreResult {
  status: "succeeded" | "failed";
  error?: string;
}

function fromBase64(body: string): Uint8Array<ArrayBuffer> {
  const binary = atob(body);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function keyPath(specification: KeyPathState): string | string[] | null {
  if (specification.kind === "none") return null;
  if (specification.kind === "string") return specification.value?.[0] ?? null;
  return specification.value ?? null;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(database: DatabaseState): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database.name, database.version);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
    request.onupgradeneeded = () => {
      const opened = request.result;

      for (const storeState of database.objectStores) {
        const store = opened.createObjectStore(storeState.name, {
          keyPath: keyPath(storeState.keyPath),
          autoIncrement: storeState.autoIncrement,
        });

        for (const index of storeState.indexes) {
          const path = keyPath(index.keyPath);
          store.createIndex(index.name, path === null ? "null" : path, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function restoreIndexedDB(databases: DatabaseState[]): Promise<void> {
  for (const databaseState of databases) {
    const database = await openDatabase(databaseState);

    try {
      for (const storeState of databaseState.objectStores) {
        const decoded = await Promise.all(
          storeState.records.map(async (record) => ({
            key: await decodeStructuredCloneAsync(record.key),
            value: await decodeStructuredCloneAsync(record.value),
          })),
        );
        if (decoded.length === 0) continue;

        const transaction = database.transaction(storeState.name, "readwrite");
        const store = transaction.objectStore(storeState.name);
        for (const record of decoded) {
          if (store.keyPath === null) store.put(record.value, record.key as IDBValidKey);
          else store.put(record.value);
        }

        await transactionDone(transaction);
      }
    } finally {
      database.close();
    }
  }
}

async function restoreCacheStorage(cachesState: StorageOrigin["cacheStorage"]): Promise<void> {
  if (cachesState === undefined) return;
  if (typeof caches === "undefined") {
    if (cachesState.length > 0) throw new Error("Cache Storage is unavailable");
    return;
  }

  for (const cacheName of await caches.keys()) {
    await caches.delete(cacheName);
  }

  for (const cacheState of cachesState) {
    const cache = await caches.open(cacheState.name);

    for (const entry of cacheState.entries) {
      const responseBody = [204, 205, 304].includes(entry.responseStatus)
        ? null
        : fromBase64(entry.responseBody);
      await cache.put(
        new Request(entry.url, { headers: entry.requestHeaders }),
        new Response(responseBody, {
          status: entry.responseStatus,
          statusText: entry.responseStatusText,
          headers: entry.responseHeaders,
        }),
      );
    }
  }
}

async function restoreOPFS(files: StorageOrigin["opfs"]): Promise<void> {
  if (files === undefined) return;
  if (typeof navigator.storage.getDirectory !== "function") {
    if (files.length > 0) throw new Error("OPFS is unavailable");
    return;
  }

  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true });
  }

  for (const fileState of files) {
    const parts = fileState.path.split("/");
    const fileName = parts.pop();
    if (fileName === undefined) throw new Error("OPFS path has no file name");

    let directory = root;
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create: true });
    }

    const file = await directory.getFileHandle(fileName, { create: true });
    const writer = await file.createWritable();
    await writer.write(fromBase64(fileState.body));
    await writer.close();
  }
}

export async function run(state: StorageOrigin): Promise<RestoreResult> {
  try {
    localStorage.clear();
    for (const entry of state.localStorage) {
      localStorage.setItem(entry.name, entry.value);
    }

    await restoreIndexedDB(state.indexedDB ?? []);
    await restoreCacheStorage(state.cacheStorage);
    await restoreOPFS(state.opfs);

    return { status: "succeeded" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  }
}
