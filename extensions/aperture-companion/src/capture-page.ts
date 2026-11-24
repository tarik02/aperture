import type { PageCodec, StorageEntry, TabDocument } from "./page-keys.ts";

/** One frame's origin and what it stores, as the function put into it tells them. */
export interface CapturedPageState {
  frameId: number;
  href: string;
  origin: string;
  /** The origins of the frames it is in, the top one first. */
  ancestorOrigins: string[];
  localStorage: StorageEntry[];
  sessionStorage: StorageEntry[];
  indexedDB?: unknown[];
  cacheStorage?: unknown[];
  opfs?: unknown[];
  profileStorageCaptured: boolean;
  webStorageCaptured: boolean;
  warnings: string[];
}

/** A tab's top document, as the function put into it tells it. */
export interface CapturedDocument {
  href: string;
  hasOpener: boolean;
  document: TabDocument;
  warnings: string[];
}

/**
 * Runs in each frame through chrome.scripting.executeScript, after capture-codec.js.
 * Chromium writes the function down by itself, so it names nothing outside its body: the
 * symbol the codec is under comes as an argument.
 */
export async function capturePageState(
  codecKey: string,
  includeProfileStorage: boolean,
): Promise<CapturedPageState> {
  const warnings: string[] = [];
  // What a session takes of one kind for one origin.
  const most = 32 * 1024 * 1024;
  const codec = Reflect.get(globalThis, Symbol.for(codecKey)) as PageCodec | undefined;
  if (codec === undefined) {
    throw new Error("The browser state codec is unavailable");
  }

  // A kind that is not read is left out and said to be, rather than failing the rest.
  async function kind(label: string, read: (limit: number) => Promise<string>) {
    try {
      const held = JSON.parse(await read(most)) as unknown[];
      return held.length === 0 ? undefined : held;
    } catch (error) {
      warnings.push(
        `${label} of ${location.origin} was left out: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return undefined;
    }
  }

  const entries = (storage: Storage): StorageEntry[] =>
    Object.keys(storage).map((name) => ({ name, value: storage.getItem(name) ?? "" }));

  const indexedDB = includeProfileStorage
    ? await kind("IndexedDB", codec.stored.databases.read)
    : undefined;
  const opfs = includeProfileStorage ? await kind("OPFS", codec.stored.files.read) : undefined;
  const cacheStorage = includeProfileStorage
    ? await kind("Cache Storage", codec.stored.caches.read)
    : undefined;

  let local: StorageEntry[] = [];
  let session: StorageEntry[] = [];
  let webStorageCaptured = true;
  try {
    local = entries(localStorage);
    session = entries(sessionStorage);
  } catch (error) {
    // A frame that is let keep nothing, as a sandboxed one.
    webStorageCaptured = false;
    warnings.push(
      `The storage of a frame of ${location.origin} was left out: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return {
    frameId: 0, // The caller puts the frame the result came from here.
    href: location.href,
    origin: location.origin,
    ancestorOrigins: Array.from(location.ancestorOrigins).reverse(),
    localStorage: local,
    sessionStorage: session,
    ...(indexedDB === undefined ? {} : { indexedDB }),
    ...(cacheStorage === undefined ? {} : { cacheStorage }),
    ...(opfs === undefined ? {} : { opfs }),
    profileStorageCaptured: includeProfileStorage,
    webStorageCaptured,
    warnings,
  };
}

/**
 * Runs in a tab's top frame through chrome.scripting.executeScript, after
 * capture-codec.js. Like capturePageState, it names nothing outside its body.
 */
export async function captureDocument(codecKey: string): Promise<CapturedDocument> {
  const codec = Reflect.get(globalThis, Symbol.for(codecKey)) as PageCodec | undefined;
  if (codec === undefined) {
    throw new Error("The browser state codec is unavailable");
  }
  const { document: held, leftOut } = await codec.document.read();
  if (new TextEncoder().encode(JSON.stringify(held)).byteLength > 32 * 1024 * 1024) {
    throw new Error("The page holds more than 32 MiB of document state");
  }
  return {
    href: location.href,
    hasOpener: window.opener !== null,
    document: held,
    warnings: leftOut.map((what) => `Left out of ${location.origin}: ${what}.`),
  };
}
