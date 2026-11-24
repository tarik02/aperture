/** The global symbol `capture-codec.js` leaves what it has under, in a page. */
export const codecKey = "aperture.companion.state";

/** A name with what is kept under it, as local and session storage have them. */
export interface StorageEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * One kind of what an origin stores, read and written as a session's runner does. What is
 * read is JSON, and reading fails where it comes to more than `limit` letters.
 */
interface Kind {
  readonly read: (limit: number) => Promise<string>;
  readonly write: (given: readonly unknown[]) => Promise<void>;
}

/** What the runner's `stored.js` evaluates to, in a page. */
export interface Stored {
  readonly encode: (value: unknown) => Promise<unknown>;
  readonly decode: (encoded: unknown) => Promise<unknown>;
  readonly databases: Kind;
  readonly caches: Kind;
  readonly files: Kind;
}

/** What a tab's document had, as the runner's `document.js` reads it and puts it back. */
export type TabDocument = Readonly<Record<string, unknown>>;

/** What the runner's `document.js` evaluates to, in a page. */
export interface DocumentState {
  readonly read: () => Promise<{ document: TabDocument; leftOut: string[] }>;
}

/** What `capture-codec.js` leaves on a page for the functions put into it after. */
export interface PageCodec {
  readonly stored: Stored;
  readonly document: DocumentState;
}
