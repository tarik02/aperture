import type { StorageEntry, TabDocument } from "./page-keys.ts";

// A storage state as a session takes one: `crates/runner/src/live/state` says what each
// part holds, and is what puts it into the session's browser.

export interface StateCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  /** Seconds since the epoch; a cookie without it ends with the browser. */
  readonly expires?: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  /** For a cookie that is kept apart for the site it was set under. */
  readonly partitionKey?: {
    readonly topLevelSite: string;
    readonly hasCrossSiteAncestor: boolean;
  };
}

export interface StateOrigin {
  origin: string;
  /** The origins of the frames it is embedded in, the top one first. */
  ancestorOrigins?: readonly string[];
  localStorage: readonly StorageEntry[];
  indexedDB?: readonly unknown[];
  cacheStorage?: readonly unknown[];
  opfs?: readonly unknown[];
}

export interface StateTab {
  readonly url: string;
  readonly active: boolean;
  /** Which of the tabs opened it, counted from zero. */
  readonly opener?: number;
  readonly sessionStorage: readonly {
    readonly origin: string;
    readonly entries: readonly StorageEntry[];
  }[];
  readonly document: TabDocument;
}

export interface StorageState {
  readonly cookies: readonly StateCookie[];
  readonly origins: StateOrigin[];
  readonly tabs: readonly StateTab[];
}
