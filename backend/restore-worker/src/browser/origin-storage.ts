import { decodeStructuredCloneAsync } from "@aperture/browser-state";
import { openDB, type IDBPDatabase } from "idb";
import type { StorageOrigin } from "../schema.js";
import { errorMessage } from "./error.js";

type DatabaseState = NonNullable<StorageOrigin["indexedDB"]>[number];

interface RestoreResult {
  status: "succeeded" | "failed";
  error?: string;
}

// The capsule schema guarantees the value arity for each kind.
function keyPath(specification: { kind: string; value?: string[] }): string | string[] | null {
  if (specification.kind === "none") return null;
  return specification.kind === "string" ? specification.value![0] : specification.value!;
}

function openDatabase(database: DatabaseState): Promise<IDBPDatabase> {
  return new Promise((resolve, reject) => {
    let wasBlocked = false;
    openDB(database.name, database.version, {
      blocked() {
        wasBlocked = true;
        reject(new Error("IndexedDB open was blocked"));
      },
      upgrade(opened) {
        for (const storeState of database.objectStores) {
          const store = opened.createObjectStore(storeState.name, {
            keyPath: keyPath(storeState.keyPath),
            autoIncrement: storeState.autoIncrement,
          });

          for (const index of storeState.indexes) {
            store.createIndex(index.name, keyPath(index.keyPath)!, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
      },
    }).then((opened) => {
      if (wasBlocked) {
        opened.close();
      } else {
        resolve(opened);
      }
    }, reject);
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
        const writes = decoded.map((record) =>
          store.keyPath === null
            ? store.put(record.value, record.key as IDBValidKey)
            : store.put(record.value),
        );

        await Promise.all([...writes, transaction.done]);
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
        : Uint8Array.fromBase64(entry.responseBody);
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
    await writer.write(Uint8Array.fromBase64(fileState.body));
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
    return { status: "failed", error: errorMessage(error) };
  }
}
