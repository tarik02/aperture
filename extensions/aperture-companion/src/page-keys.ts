// Global symbol under which capture-codec.js registers the structured clone codec in a page.
export const codecKey = "aperture.structured-clone-codec";

/** The codec as the injected capture functions find it on the page. */
export interface PageCodec {
  readonly encodeStructuredClone: (value: unknown, allowCryptoKeys: boolean) => Promise<string>;
}
