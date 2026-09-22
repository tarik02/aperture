import { encodeStructuredClone } from "@aperture/browser-state";

const codecSymbol = Symbol.for("aperture.structured-clone-codec");

Object.defineProperty(globalThis, codecSymbol, {
  configurable: true,
  value: { encodeStructuredClone },
});
