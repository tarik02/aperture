import { encodeStructuredClone } from "@aperture-browser/browser-state";
import { codecKey } from "./page-keys.ts";

Object.defineProperty(globalThis, Symbol.for(codecKey), {
  configurable: true,
  value: { encodeStructuredClone },
});
