import { decodeStructuredCloneAsync } from "@aperture/browser-state";

export async function run(state) {
  try {
    const fromBase64 = (body) => {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };
    const keyPath = (specification) => {
      if (specification.kind === "none") return null;
      if (specification.kind === "string") return specification.value[0];
      return specification.value;
    };
    const transactionDone = (transaction) =>
      new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () =>
          reject(transaction.error || new Error("IndexedDB transaction failed"));
        transaction.onabort = () =>
          reject(transaction.error || new Error("IndexedDB transaction aborted"));
      });
    const openDatabase = (database) =>
      new Promise((resolve, reject) => {
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
              store.createIndex(index.name, keyPath(index.keyPath), {
                unique: index.unique,
                multiEntry: index.multiEntry,
              });
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
      });

    localStorage.clear();
    for (const entry of state.localStorage) localStorage.setItem(entry.name, entry.value);
    for (const databaseState of state.indexedDB || []) {
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
            if (store.keyPath === null) store.put(record.value, record.key);
            else store.put(record.value);
          }
          await transactionDone(transaction);
        }
      } finally {
        database.close();
      }
    }
    if (state.cacheStorage !== undefined && typeof caches === "undefined") {
      if (state.cacheStorage.length > 0) throw new Error("Cache Storage is unavailable");
    } else if (state.cacheStorage !== undefined) {
      for (const cacheName of await caches.keys()) await caches.delete(cacheName);
      for (const cacheState of state.cacheStorage || []) {
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
    if (state.opfs !== undefined && typeof navigator.storage.getDirectory === "function") {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
      for (const fileState of state.opfs || []) {
        const parts = fileState.path.split("/");
        const fileName = parts.pop();
        let directory = root;
        for (const part of parts)
          directory = await directory.getDirectoryHandle(part, { create: true });
        const file = await directory.getFileHandle(fileName, { create: true });
        const writer = await file.createWritable();
        await writer.write(fromBase64(fileState.body));
        await writer.close();
      }
    } else if ((state.opfs || []).length > 0) {
      throw new Error("OPFS is unavailable");
    }
    return { status: "succeeded" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  }
}
