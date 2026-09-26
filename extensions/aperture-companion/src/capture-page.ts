import type * as Api from "@aperture-browser/api-schema";
import type { PageCodec } from "./page-keys.ts";

// The encoded forms: sensitive values stay plain strings until the service worker decodes them.
type BrowserStorageEntry = typeof Api.BrowserStorageEntry.Encoded;
type InitialCacheStorageCache = typeof Api.InitialCacheStorageCache.Encoded;
type InitialIndexedDBDatabase = typeof Api.InitialIndexedDBDatabase.Encoded;
type InitialIndexedDBIndexKeyPath = typeof Api.InitialIndexedDBIndexKeyPath.Encoded;
type InitialIndexedDBKeyPath = typeof Api.InitialIndexedDBKeyPath.Encoded;
type InitialOPFSFile = typeof Api.InitialOPFSFile.Encoded;

/** One frame's origin and storage, as the injected capture function reports them. */
export interface CapturedPageState {
  frameId: number;
  href: string;
  origin: string;
  ancestorOrigins: string[];
  localStorage: BrowserStorageEntry[];
  sessionStorage: BrowserStorageEntry[];
  scroll: { x: number; y: number };
  indexedDB?: InitialIndexedDBDatabase[];
  cacheStorage?: InitialCacheStorageCache[];
  opfs?: InitialOPFSFile[];
  profileStorageCaptured: boolean;
  webStorageCaptured: boolean;
  warnings: string[];
}

/**
 * Runs inside each frame through chrome.scripting.executeScript, after capture-codec.js.
 * Chromium serializes the function on its own, so it must not reference anything outside
 * its body: the codec's global key comes in as an argument.
 */
export async function capturePageState(
  codecKey: string,
  includeProfileStorage: boolean,
): Promise<CapturedPageState> {
  const warnings: string[] = [];
  const profileStorageLimit = 32 * 1024 * 1024;
  let profileStorageBytes = 0;
  const codec = Reflect.get(globalThis, Symbol.for(codecKey)) as PageCodec | undefined;
  if (codec === undefined) {
    throw new Error("The browser state codec is unavailable");
  }
  const { encodeStructuredClone } = codec;

  function retainProfileStorage(label: string, value: unknown): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (profileStorageBytes + bytes > profileStorageLimit) {
      warnings.push(`${label} was skipped because browser storage exceeds 32 MiB`);
      return false;
    }
    profileStorageBytes += bytes;
    return true;
  }

  function storageEntries(storage: Storage): BrowserStorageEntry[] {
    return Object.keys(storage).map((name) => ({
      name,
      value: storage.getItem(name) ?? "",
    }));
  }

  function indexKeyPath(value: string | string[]): InitialIndexedDBIndexKeyPath {
    return Array.isArray(value)
      ? { kind: "array", value: [...value] }
      : { kind: "string", value: [value] };
  }

  function objectStoreKeyPath(value: string | string[] | null): InitialIndexedDBKeyPath {
    return value === null ? { kind: "none" } : indexKeyPath(value);
  }

  function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 32 * 1024;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function openDatabase(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error ?? new Error(`could not open ${name}`));
      request.onsuccess = () => resolve(request.result);
    });
  }

  function readStoreRecords(
    database: IDBDatabase,
    storeName: string,
  ): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
    return new Promise((resolve, reject) => {
      const records: Array<{ key: IDBValidKey; value: unknown }> = [];
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).openCursor();
      request.onerror = () => reject(request.error ?? new Error(`could not read ${storeName}`));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error(`could not read ${storeName}`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          return;
        }
        records.push({ key: cursor.primaryKey, value: cursor.value });
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(records);
    });
  }

  async function captureIndexedDB(): Promise<InitialIndexedDBDatabase[] | undefined> {
    if (typeof indexedDB.databases !== "function") {
      warnings.push("IndexedDB enumeration is unavailable");
      return undefined;
    }
    let databaseInfos: IDBDatabaseInfo[];
    try {
      databaseInfos = await indexedDB.databases();
    } catch (error) {
      warnings.push(
        `IndexedDB was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const databases: InitialIndexedDBDatabase[] = [];
    for (const info of databaseInfos) {
      if (info.name === undefined) {
        continue;
      }
      let database: IDBDatabase | null = null;
      try {
        database = await openDatabase(info.name);
        const objectStores = [];
        for (const storeName of database.objectStoreNames) {
          const metadataTransaction = database.transaction(storeName, "readonly");
          const store = metadataTransaction.objectStore(storeName);
          const indexes = Array.from(store.indexNames, (name) => {
            const index = store.index(name);
            return {
              name,
              keyPath: indexKeyPath(index.keyPath),
              unique: index.unique,
              multiEntry: index.multiEntry,
            };
          });
          const rawRecords = await readStoreRecords(database, storeName);
          const records = [];
          for (const record of rawRecords) {
            records.push({
              key: await encodeStructuredClone(record.key, true),
              value: await encodeStructuredClone(record.value, true),
            });
          }
          objectStores.push({
            name: storeName,
            keyPath: objectStoreKeyPath(store.keyPath),
            autoIncrement: store.autoIncrement,
            indexes,
            records,
          });
        }
        databases.push({
          name: info.name,
          version: database.version,
          objectStores,
        });
      } catch (error) {
        warnings.push(
          `IndexedDB was skipped because ${info.name} could not be captured: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      } finally {
        database?.close();
      }
    }
    return retainProfileStorage("IndexedDB", databases) ? databases : undefined;
  }

  async function captureCacheStorage(): Promise<InitialCacheStorageCache[] | undefined> {
    if (!("caches" in globalThis)) {
      warnings.push("Cache Storage is unavailable");
      return undefined;
    }
    const captured: InitialCacheStorageCache[] = [];
    for (const name of await caches.keys()) {
      try {
        const cache = await caches.open(name);
        const entries = [];
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          if (response === undefined || response.status === 0) {
            throw new Error("opaque responses are not portable");
          }
          const responseHeaders = Object.fromEntries(response.headers.entries());
          delete responseHeaders["content-encoding"];
          delete responseHeaders["content-length"];
          entries.push({
            url: request.url,
            requestHeaders: Object.fromEntries(request.headers.entries()),
            responseHeaders,
            responseStatus: response.status,
            responseStatusText: response.statusText,
            responseBody: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
          });
        }
        captured.push({ name, entries });
      } catch (error) {
        warnings.push(
          `Cache Storage was skipped because ${name} could not be captured: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    }
    return retainProfileStorage("Cache Storage", captured) ? captured : undefined;
  }

  async function captureOPFS(): Promise<InitialOPFSFile[] | undefined> {
    if (typeof navigator.storage.getDirectory !== "function") {
      warnings.push("OPFS is unavailable");
      return undefined;
    }
    const files: InitialOPFSFile[] = [];
    async function walk(directory: FileSystemDirectoryHandle, prefix: string): Promise<void> {
      for await (const [name, handle] of directory.entries()) {
        const childPath = prefix === "" ? name : `${prefix}/${name}`;
        if (handle.kind === "directory") {
          await walk(handle, childPath);
        } else {
          const file = await handle.getFile();
          files.push({
            path: childPath,
            body: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
          });
        }
      }
    }
    try {
      await walk(await navigator.storage.getDirectory(), "");
      if (!retainProfileStorage("OPFS", files)) {
        return undefined;
      }
    } catch (error) {
      warnings.push(`OPFS was skipped: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    return files;
  }

  const indexedDBState = includeProfileStorage ? await captureIndexedDB() : undefined;
  const opfs = includeProfileStorage ? await captureOPFS() : undefined;
  const cacheStorage = includeProfileStorage ? await captureCacheStorage() : undefined;
  let localStorageEntries: BrowserStorageEntry[] = [];
  let sessionStorageEntries: BrowserStorageEntry[] = [];
  let webStorageCaptured = true;
  try {
    localStorageEntries = storageEntries(localStorage);
    sessionStorageEntries = storageEntries(sessionStorage);
  } catch (error) {
    webStorageCaptured = false;
    warnings.push(
      `Web Storage was skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    frameId: 0, // The caller replaces this with the frame the result came from.
    href: location.href,
    origin: location.origin,
    ancestorOrigins: Array.from(location.ancestorOrigins).reverse(),
    localStorage: localStorageEntries,
    sessionStorage: sessionStorageEntries,
    scroll: { x: scrollX, y: scrollY },
    ...(indexedDBState === undefined ? {} : { indexedDB: indexedDBState }),
    ...(cacheStorage === undefined ? {} : { cacheStorage }),
    ...(opfs === undefined ? {} : { opfs }),
    profileStorageCaptured: includeProfileStorage,
    webStorageCaptured,
    warnings,
  };
}
