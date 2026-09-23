import type {
  BrowserStorageEntry,
  InitialCacheStorageCache,
  InitialBrowserCookie,
  InitialBrowserStorageState,
  InitialBrowserTarget,
  InitialIndexedDBDatabase,
  InitialIndexedDBKeyPath,
  InitialOPFSFile,
} from "@aperture/api-client";
import { captureDocumentState, type CapturedDocumentState } from "./document-state";

export interface CapturedBrowserState {
  targets: InitialBrowserTarget[];
  storageState: InitialBrowserStorageState;
  warnings: string[];
}

interface CapturedTabState {
  tab: chrome.tabs.Tab;
  top: CapturedPageState;
  frames: CapturedPageState[];
  document: CapturedDocumentState;
}

const preferredPayloadBytes = 48 * 1024 * 1024;

export async function requestCapturePermissions(tabs: chrome.tabs.Tab[]): Promise<void> {
  if (tabs.length === 0) {
    throw new Error("No web pages are selected");
  }
  const origins = [...new Set(tabs.map(tabOriginPattern))];
  if (!(await chrome.permissions.request({ origins }))) {
    throw new Error("Access to the selected websites was not granted");
  }
}

export async function captureBrowserState(
  tabs: chrome.tabs.Tab[],
  activeTabId: number,
): Promise<CapturedBrowserState> {
  if (tabs.length === 0) {
    throw new Error("No browser tabs were selected");
  }
  const pages = await Promise.all(tabs.map(captureTab));
  await captureProfileStorage(pages);
  await Promise.all(pages.map(validateCapturedTab));
  const selectedHosts = new Set(
    pages.flatMap(({ frames }) => frames.map(({ href }) => new URL(href).hostname.toLowerCase())),
  );
  const selectedTopLevelSites = pages.map(({ top }) => new URL(top.href));
  const capturedCookies = await chrome.cookies.getAll({});
  const cookies = capturedCookies
    .filter((cookie) => cookieMatchesSelectedContext(cookie, selectedHosts, selectedTopLevelSites))
    .map(toInitialCookie);
  const origins = mergeOrigins(pages);
  const targetIndexByTabID = new Map(
    pages.flatMap(({ tab }, index) => (tab.id === undefined ? [] : [[tab.id, index] as const])),
  );
  const targets = pages.map(({ tab, top, frames, document }) => {
    const openerTargetIndex =
      document.hasOpener && tab.openerTabId !== undefined
        ? targetIndexByTabID.get(tab.openerTabId)
        : undefined;
    return {
      url: top.href,
      sessionStorage: mergeSessionStorage(frames),
      scroll: top.scroll,
      documentState: document.state,
      ...(openerTargetIndex === undefined ? {} : { openerTargetIndex }),
      active: tab.id === activeTabId,
    };
  });
  const warnings = pages.flatMap(({ frames, document }) => [
    ...frames.flatMap(({ warnings: frameWarnings }) => frameWarnings),
    ...document.warnings,
  ]);
  const storageState = { cookies, origins };
  trimOptionalStorage(storageState, targets, warnings);
  return { targets, storageState, warnings };
}

async function captureTab(tab: chrome.tabs.Tab): Promise<CapturedTabState> {
  if (tab.id === undefined || tab.url === undefined) {
    throw new Error("A selected tab is unavailable");
  }
  const expectedURL = new URL(tab.url);
  if (expectedURL.protocol !== "http:" && expectedURL.protocol !== "https:") {
    throw new Error("Teleport supports HTTP and HTTPS pages only");
  }
  const [frames, document] = await Promise.all([
    capturePageStates(tab.id, false),
    captureDocumentState(tab.id),
  ]);
  const top = frames.find(({ frameId }) => frameId === 0);
  if (top === undefined) {
    throw new Error("The selected tab did not return its main frame state");
  }
  for (const frame of frames) {
    if (frame.frameId === 0 && frame.ancestorOrigins.length !== 0) {
      throw new Error("The selected tab returned an invalid main frame partition");
    }
    if (frame.frameId !== 0 && frame.ancestorOrigins[0] !== top.origin) {
      throw new Error(`A frame returned an invalid storage partition for ${frame.origin}`);
    }
  }
  const currentTab = await chrome.tabs.get(tab.id);
  if (
    currentTab.url === undefined ||
    currentTab.url !== top.href ||
    document.href !== top.href ||
    top.origin !== new URL(top.href).origin ||
    top.origin !== expectedURL.origin
  ) {
    throw new Error(
      `The tab navigated while its state was being captured: ${tab.title ?? tab.url}`,
    );
  }
  return { tab: currentTab, top, frames, document };
}

async function captureProfileStorage(tabs: CapturedTabState[]): Promise<void> {
  const partitionCandidates = new Map<string, Array<{ tabId: number; frame: CapturedPageState }>>();
  for (const tab of tabs) {
    if (tab.tab.id === undefined) {
      throw new Error("A selected tab is unavailable");
    }
    for (const frame of tab.frames) {
      if (!frame.webStorageCaptured) {
        continue;
      }
      const partition = storagePartitionKey(frame);
      const candidates = partitionCandidates.get(partition) ?? [];
      candidates.push({ tabId: tab.tab.id, frame });
      partitionCandidates.set(partition, candidates);
    }
  }
  await Promise.all(
    [...partitionCandidates].map(async ([partition, candidates]) => {
      for (const { tabId, frame } of candidates) {
        const captured = await capturePageStates(tabId, true, frame.frameId);
        const profile = captured[0];
        if (
          profile === undefined ||
          profile.origin !== frame.origin ||
          storagePartitionKey(profile) !== partition
        ) {
          throw new Error(`A frame navigated while ${frame.origin} was being captured`);
        }
        frame.warnings.push(...profile.warnings);
        if (!profile.webStorageCaptured) {
          continue;
        }
        frame.indexedDB = profile.indexedDB;
        frame.cacheStorage = profile.cacheStorage;
        frame.opfs = profile.opfs;
        frame.profileStorageCaptured = true;
        return;
      }
    }),
  );
}

async function validateCapturedTab({ tab, top }: CapturedTabState): Promise<void> {
  if (tab.id === undefined) {
    throw new Error("A selected tab is unavailable");
  }
  const current = await chrome.tabs.get(tab.id);
  if (current.url !== top.href) {
    throw new Error(
      `The tab navigated while its state was being captured: ${tab.title ?? top.href}`,
    );
  }
}

function mergeOrigins(pages: CapturedTabState[]): InitialBrowserStorageState["origins"] {
  const origins = new Map<string, InitialBrowserStorageState["origins"][number]>();
  for (const page of pages.flatMap(({ frames }) => frames)) {
    if (!page.webStorageCaptured) {
      continue;
    }
    const partition = storagePartitionKey(page);
    const existing = origins.get(partition);
    if (existing !== undefined) {
      if (JSON.stringify(existing.localStorage) !== JSON.stringify(page.localStorage)) {
        throw new Error(`Local storage changed while ${page.origin} was being captured`);
      }
      if (page.profileStorageCaptured) {
        if (page.indexedDB !== undefined) existing.indexedDB = page.indexedDB;
        if (page.cacheStorage !== undefined) existing.cacheStorage = page.cacheStorage;
        if (page.opfs !== undefined) existing.opfs = page.opfs;
      }
      continue;
    }
    origins.set(partition, {
      origin: page.origin,
      ...(page.ancestorOrigins.length === 0 ? {} : { ancestorOrigins: page.ancestorOrigins }),
      localStorage: page.localStorage,
      ...(page.profileStorageCaptured
        ? {
            ...(page.indexedDB === undefined ? {} : { indexedDB: page.indexedDB }),
            ...(page.cacheStorage === undefined ? {} : { cacheStorage: page.cacheStorage }),
            ...(page.opfs === undefined ? {} : { opfs: page.opfs }),
          }
        : {}),
    });
  }
  return [...origins.values()];
}

function mergeSessionStorage(
  frames: CapturedPageState[],
): NonNullable<InitialBrowserTarget["sessionStorage"]> {
  const origins = new Map<string, NonNullable<InitialBrowserTarget["sessionStorage"]>[number]>();
  for (const frame of frames) {
    if (!frame.webStorageCaptured) {
      continue;
    }
    const existing = origins.get(frame.origin);
    if (existing !== undefined) {
      if (JSON.stringify(existing.entries) !== JSON.stringify(frame.sessionStorage)) {
        throw new Error(`Session storage changed while ${frame.origin} was being captured`);
      }
      continue;
    }
    origins.set(frame.origin, { origin: frame.origin, entries: frame.sessionStorage });
  }
  return [...origins.values()];
}

function trimOptionalStorage(
  storageState: InitialBrowserStorageState,
  targets: InitialBrowserTarget[],
  warnings: string[],
): void {
  if (payloadBytes(storageState, targets) <= preferredPayloadBytes) {
    return;
  }
  let omittedCacheStorage = false;
  for (const origin of [...storageState.origins].reverse()) {
    if (payloadBytes(storageState, targets) <= preferredPayloadBytes) break;
    if (origin.cacheStorage !== undefined) {
      delete origin.cacheStorage;
      omittedCacheStorage = true;
    }
  }
  if (omittedCacheStorage) {
    warnings.push("Cache Storage was omitted because the captured browser state is too large");
  }
  if (payloadBytes(storageState, targets) <= preferredPayloadBytes) {
    return;
  }
  let omittedOPFS = false;
  for (const origin of [...storageState.origins].reverse()) {
    if (payloadBytes(storageState, targets) <= preferredPayloadBytes) break;
    if (origin.opfs !== undefined) {
      delete origin.opfs;
      omittedOPFS = true;
    }
  }
  if (omittedOPFS) {
    warnings.push("OPFS was omitted because the captured browser state is too large");
  }
  if (payloadBytes(storageState, targets) <= preferredPayloadBytes) {
    return;
  }
  let omittedIndexedDB = false;
  for (const origin of [...storageState.origins].reverse()) {
    if (payloadBytes(storageState, targets) <= preferredPayloadBytes) break;
    if (origin.indexedDB !== undefined) {
      delete origin.indexedDB;
      omittedIndexedDB = true;
    }
  }
  if (omittedIndexedDB) {
    warnings.push("IndexedDB was omitted because the captured browser state is too large");
  }
  if (payloadBytes(storageState, targets) > preferredPayloadBytes) {
    throw new Error("The selected tabs contain more than 48 MiB of essential browser state");
  }
}

function payloadBytes(
  storageState: InitialBrowserStorageState,
  targets: InitialBrowserTarget[],
): number {
  return encodedBytes({ storageState, targets });
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function cookieMatchesSelectedContext(
  cookie: chrome.cookies.Cookie,
  selectedHosts: Set<string>,
  selectedTopLevelSites: URL[],
): boolean {
  const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
  let domainMatches = false;
  for (const hostname of selectedHosts) {
    if (hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`)) {
      domainMatches = true;
      break;
    }
  }
  if (!domainMatches) {
    return false;
  }

  if (cookie.partitionKey === undefined) {
    return true;
  }
  if (cookie.partitionKey.topLevelSite === undefined) {
    return false;
  }

  const partitionSite = new URL(cookie.partitionKey.topLevelSite);
  return selectedTopLevelSites.some(
    (selectedSite) =>
      selectedSite.protocol === partitionSite.protocol &&
      (selectedSite.hostname === partitionSite.hostname ||
        selectedSite.hostname.endsWith(`.${partitionSite.hostname}`)),
  );
}

function tabOriginPattern(tab: chrome.tabs.Tab): string {
  if (tab.url === undefined) {
    throw new Error("A selected tab is unavailable");
  }
  const url = new URL(tab.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Teleport supports HTTP and HTTPS pages only");
  }
  return `${url.origin}/*`;
}

function toInitialCookie(cookie: chrome.cookies.Cookie): InitialBrowserCookie {
  const cookieSameSite = sameSite(cookie.sameSite);
  const topLevelSite = cookie.partitionKey?.topLevelSite;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.hostOnly ? { hostOnly: true } : {}),
    ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
    ...(cookie.httpOnly ? { httpOnly: true } : {}),
    ...(cookie.secure ? { secure: true } : {}),
    ...(cookieSameSite === undefined ? {} : { sameSite: cookieSameSite }),
    ...(topLevelSite === undefined
      ? {}
      : {
          partitionKey: {
            topLevelSite,
            ...(cookie.partitionKey?.hasCrossSiteAncestor === undefined
              ? {}
              : { hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor }),
          },
        }),
  };
}

function sameSite(value: chrome.cookies.Cookie["sameSite"]): InitialBrowserCookie["sameSite"] {
  switch (value) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "no_restriction":
      return "None";
    case "unspecified":
      return undefined;
  }
}

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

export async function capturePageStates(
  tabId: number,
  captureProfileStorage: boolean,
  frameId?: number,
): Promise<CapturedPageState[]> {
  const target =
    frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({ target, files: ["capture-codec.js"] });
  const injections = await chrome.scripting.executeScript({
    target,
    args: [captureProfileStorage],
    func: async (includeProfileStorage: boolean): Promise<CapturedPageState> => {
      const warnings: string[] = [];
      const profileStorageLimit = 32 * 1024 * 1024;
      let profileStorageBytes = 0;
      const codec = (
        globalThis as typeof globalThis & {
          [key: symbol]: {
            encodeStructuredClone(value: unknown, allowCryptoKeys: boolean): Promise<string>;
          };
        }
      )[Symbol.for("aperture.structured-clone-codec")];
      if (codec === undefined) {
        throw new Error("The browser state codec is unavailable");
      }

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

      function keyPath(value: string | string[] | null): InitialIndexedDBKeyPath {
        if (value === null) {
          return { kind: "none" };
        }
        return Array.isArray(value)
          ? { kind: "array", value: [...value] }
          : { kind: "string", value: [value] };
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
                  keyPath: keyPath(index.keyPath),
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                };
              });
              const rawRecords = await readStoreRecords(database, storeName);
              const records = [];
              for (const record of rawRecords) {
                records.push({
                  key: await codec.encodeStructuredClone(record.key, true),
                  value: await codec.encodeStructuredClone(record.value, true),
                });
              }
              objectStores.push({
                name: storeName,
                keyPath: keyPath(store.keyPath),
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
          warnings.push(
            `OPFS was skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
        return files;
      }

      const captureOriginStorage = includeProfileStorage;
      const indexedDBState = captureOriginStorage ? await captureIndexedDB() : undefined;
      const opfs = captureOriginStorage ? await captureOPFS() : undefined;
      const cacheStorage = captureOriginStorage ? await captureCacheStorage() : undefined;
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
        frameId: 0,
        href: location.href,
        origin: location.origin,
        ancestorOrigins: Array.from(location.ancestorOrigins).reverse(),
        localStorage: localStorageEntries,
        sessionStorage: sessionStorageEntries,
        scroll: { x: scrollX, y: scrollY },
        ...(indexedDBState === undefined ? {} : { indexedDB: indexedDBState }),
        ...(cacheStorage === undefined ? {} : { cacheStorage }),
        ...(opfs === undefined ? {} : { opfs }),
        profileStorageCaptured: captureOriginStorage,
        webStorageCaptured,
        warnings,
      };
    },
  });
  const captured = injections.flatMap(({ frameId, result }) => {
    if (result === undefined) {
      return [];
    }
    const protocol = new URL(result.href).protocol;
    return protocol === "http:" || protocol === "https:" ? [{ ...result, frameId }] : [];
  });
  const expectedFrameId = frameId ?? 0;
  if (!captured.some(({ frameId: capturedFrameId }) => capturedFrameId === expectedFrameId)) {
    throw new Error("The requested frame did not return browser state");
  }
  return captured;
}

function storagePartitionKey(page: CapturedPageState): string {
  return [page.origin, ...page.ancestorOrigins].join("\u0000");
}
