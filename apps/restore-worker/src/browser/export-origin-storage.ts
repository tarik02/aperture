import { encodeStructuredClone } from "@aperture-browser/browser-state";
import type {
  InitialIndexedDBDatabase,
  InitialIndexedDBObjectStore,
  InitialCacheStorageCache,
  InitialCacheStorageEntry,
  InitialOPFSFile,
} from "@aperture-browser/api-schema";
import type * as Schema from "effect/Schema";
import { openDB } from "idb";
import type { ExportedStorageOrigin } from "../export-schema.js";

function keyPath(value: string | string[] | null) {
  if (value === null) return { kind: "none" } as const;
  if (Array.isArray(value)) return { kind: "array", value } as const;
  return { kind: "string", value: [value] } as const;
}

async function exportIndexedDB(): Promise<
  readonly Schema.Codec.Encoded<typeof InitialIndexedDBDatabase>[]
> {
  const result: Schema.Codec.Encoded<typeof InitialIndexedDBDatabase>[] = [];
  for (const { name, version } of await indexedDB.databases()) {
    if (name === undefined || version === undefined)
      throw new Error("IndexedDB database metadata is incomplete");
    let disappeared = false;
    const database = await openDB(name, version, {
      upgrade(_db, _old, _next, tx) {
        disappeared = true;
        tx.abort();
      },
    });
    try {
      if (disappeared) throw new Error("IndexedDB changed during export");
      const names = [...database.objectStoreNames];
      const stores: Schema.Codec.Encoded<typeof InitialIndexedDBObjectStore>[] = [];
      if (names.length > 0) {
        // Read all stores in one readonly transaction; encode after it completes, since
        // asynchronous Blob/CryptoKey conversion would otherwise let it auto-commit.
        const transaction = database.transaction(names, "readonly");
        const pending = names.map(async (storeName) => {
          const store = transaction.objectStore(storeName);
          const indexes = [...store.indexNames].map((indexName) => {
            const index = store.index(indexName);
            const path = keyPath(index.keyPath);
            if (path.kind === "none") throw new Error("IndexedDB index has no key path");
            return {
              name: indexName,
              keyPath: path,
              unique: index.unique,
              multiEntry: index.multiEntry,
            };
          });
          const [keys, values]: [IDBValidKey[], unknown[]] = await Promise.all([
            store.getAllKeys(),
            store.getAll(),
          ]);
          return {
            name: storeName,
            keyPath: keyPath(store.keyPath),
            autoIncrement: store.autoIncrement,
            indexes,
            keys,
            values,
          };
        });
        const rawStores = await Promise.all(pending);
        await transaction.done;
        for (const { keys, values, ...store } of rawStores) {
          const records = [];
          for (let index = 0; index < keys.length; index++) {
            records.push({
              key: await encodeStructuredClone(keys[index], true),
              value: await encodeStructuredClone(values[index], true),
            });
          }
          stores.push({ ...store, records });
        }
      }
      result.push({ name, version, objectStores: stores });
    } finally {
      database.close();
    }
  }
  return result;
}

async function exportCaches(): Promise<
  readonly Schema.Codec.Encoded<typeof InitialCacheStorageCache>[]
> {
  if (!("caches" in globalThis)) return [];
  const result: Schema.Codec.Encoded<typeof InitialCacheStorageCache>[] = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    const entries: Schema.Codec.Encoded<typeof InitialCacheStorageEntry>[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response === undefined) throw new Error("Cache Storage changed during export");
      if (
        response.type === "opaque" ||
        response.type === "opaqueredirect" ||
        response.status === 0
      ) {
        throw new Error("Opaque cache responses are not portable");
      }
      entries.push({
        url: request.url,
        requestHeaders: Object.fromEntries(request.headers),
        responseHeaders: Object.fromEntries(response.headers),
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseBody: new Uint8Array(await response.arrayBuffer()).toBase64(),
      });
    }
    result.push({ name, entries });
  }
  return result;
}

async function exportFiles(): Promise<readonly Schema.Codec.Encoded<typeof InitialOPFSFile>[]> {
  if (!("getDirectory" in navigator.storage)) return [];
  const result: Schema.Codec.Encoded<typeof InitialOPFSFile>[] = [];
  async function readDirectory(
    directory: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix + name;
      if (handle.kind === "directory") {
        await readDirectory(handle, `${path}/`);
      } else {
        const file = await handle.getFile();
        if (file.size > 64 * 1024 * 1024) throw new Error("OPFS file exceeds the export limit");
        result.push({ path, body: new Uint8Array(await file.arrayBuffer()).toBase64() });
      }
    }
  }
  await readDirectory(await navigator.storage.getDirectory(), "");
  return result;
}

export async function run(quota: boolean): Promise<ExportedStorageOrigin> {
  const local = [];
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index);
    if (name === null) throw new Error("localStorage changed during export");
    const value = localStorage.getItem(name);
    if (value === null) throw new Error("localStorage changed during export");
    local.push({ name, value });
  }
  return {
    origin: location.origin,
    localStorage: local,
    ...(quota
      ? {
          indexedDB: await exportIndexedDB(),
          cacheStorage: await exportCaches(),
          opfs: await exportFiles(),
        }
      : {}),
  };
}
