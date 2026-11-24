import { documentOf, stored } from "virtual:runner-state";
import { codecKey, type PageCodec } from "./page-keys.ts";

Object.defineProperty(globalThis, Symbol.for(codecKey), {
  configurable: true,
  value: { stored, document: documentOf(stored) } satisfies PageCodec,
});
