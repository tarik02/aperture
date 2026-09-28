import {
  ExportSessionStorageStateInput,
  InitialBrowserCookie,
  InitialBrowserStorageState,
  InitialStorageOrigin,
} from "@aperture-browser/api-schema";
import * as Schema from "effect/Schema";
import { canonicalOrigin } from "./schema.js";

export const StorageExportInput = ExportSessionStorageStateInput.check(
  Schema.makeFilter(({ origins }) => {
    if (origins === "open-tabs") return true;
    return (
      origins.every((pattern) => {
        if (pattern === "*") return true;
        if (!pattern.includes("*")) return canonicalOrigin(pattern) !== null;
        return /^(https?|\*):\/\/[^/?#@\s]+\/?$/.test(pattern);
      }) ||
      "origins must contain HTTP origins or origin patterns without paths, credentials, queries, or fragments"
    );
  }),
);
export type StorageExportInput = typeof StorageExportInput.Type;
export const ExportedStorageState = Schema.toEncoded(InitialBrowserStorageState);
export type ExportedStorageState = typeof ExportedStorageState.Type;
export const ExportedStorageOrigin = Schema.toEncoded(InitialStorageOrigin);
export type ExportedStorageOrigin = typeof ExportedStorageOrigin.Type;
/** What the browser payload reports for one origin. */
export const OriginStorageExport = Schema.Union([
  Schema.Struct({ storage: ExportedStorageOrigin }),
  Schema.Struct({ unsupported: Schema.String }),
]);
export type OriginStorageExport = typeof OriginStorageExport.Type;
export const ExportedCookie = Schema.toEncoded(InitialBrowserCookie);
export type ExportedCookie = typeof ExportedCookie.Type;

export interface StoragePartition {
  readonly origin: string;
  readonly ancestors: readonly string[];
  readonly storageKey: string;
  readonly quota: boolean;
}

/** Patterns match the entire canonical origin; only * has special meaning. */
export function matchesOrigin(patterns: readonly string[], origin: string): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes("*")) return canonicalOrigin(pattern) === origin;
    const parts = pattern.replace(/\/$/, "").toLowerCase().split("*");
    const value = origin.toLowerCase();
    if (!value.startsWith(parts[0])) return false;
    let position = parts[0].length;
    // Match literal fragments in order. Unlike a chain of .* expressions, this
    // cannot cause exponential regular-expression backtracking.
    for (let index = 1; index < parts.length; index++) {
      const part = parts[index];
      const next =
        index === parts.length - 1 ? value.length - part.length : value.indexOf(part, position);
      if (next < position || !value.startsWith(part, next)) return false;
      position = next + part.length;
    }
    return true;
  });
}
