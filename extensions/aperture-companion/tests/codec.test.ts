import { stored } from "virtual:runner-state";
import { describe, expect, it } from "vite-plus/test";

// What a database or `history.state` holds that JSON does not, written down in a page of
// someone's browser and made again in a page of a session's: both by the runner's own
// `stored.js`, which is what the extension puts into the pages it takes a state from.

const carried = async (value: unknown) =>
  stored.decode(JSON.parse(JSON.stringify(await stored.encode(value))));

describe("what a state carries of a value JSON does not hold", () => {
  it("numbers, dates, patterns and big integers come back as they were", async () => {
    const back = await carried({
      nan: Number.NaN,
      minusZero: -0,
      infinite: Number.NEGATIVE_INFINITY,
      none: undefined,
      at: new Date(86_400_000),
      pattern: /a+/giu,
      big: 2n ** 70n,
    });
    expect(back).toEqual({
      nan: Number.NaN,
      minusZero: -0,
      infinite: Number.NEGATIVE_INFINITY,
      none: undefined,
      at: new Date(86_400_000),
      pattern: /a+/giu,
      big: 2n ** 70n,
    });
    expect(Object.is((back as { minusZero: number }).minusZero, -0)).toBe(true);
    expect("none" in (back as object)).toBe(true);
  });

  it("bytes come back as the kind of array they were", async () => {
    const back = (await carried({
      buffer: new Uint16Array([1, 65_535]).buffer,
      bytes: new Uint8Array([1, 2, 250]),
      floats: new Float64Array([0.5, -2]),
      view: new DataView(new Uint8Array([7, 8]).buffer),
    })) as Record<string, unknown>;
    expect(back["buffer"]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint16Array(back["buffer"] as ArrayBuffer)]).toEqual([1, 65_535]);
    expect(back["bytes"]).toEqual(new Uint8Array([1, 2, 250]));
    expect(back["floats"]).toEqual(new Float64Array([0.5, -2]));
    expect((back["view"] as DataView).getUint8(1)).toBe(8);
  });

  it("maps, sets and what holds itself keep their shape", async () => {
    const cyclic: Record<string, unknown> = { name: "c" };
    cyclic["self"] = cyclic;
    const shared = { n: 1 };
    const back = (await carried({
      map: new Map<unknown, unknown>([
        ["k", new Date(0)],
        [1, shared],
      ]),
      set: new Set([shared, "s"]),
      cyclic,
      sparse: Object.assign([1], { 3: 4 }),
    })) as { map: Map<unknown, unknown>; set: Set<unknown>; cyclic: Record<string, unknown> };
    expect(back.map.get("k")).toEqual(new Date(0));
    // What was held twice is one thing still.
    expect(back.set.has(back.map.get(1))).toBe(true);
    expect(back.cyclic["self"]).toBe(back.cyclic);
  });

  it("files and blobs come back with their bytes and what they are called", async () => {
    const back = (await carried({
      blob: new Blob(["x", "y"], { type: "text/plain" }),
      file: new File(["z"], "note.txt", { type: "text/plain", lastModified: 5 }),
    })) as { blob: Blob; file: File };
    expect([back.blob.type, await back.blob.text()]).toEqual(["text/plain", "xy"]);
    expect(back.file).toBeInstanceOf(File);
    expect([back.file.name, back.file.lastModified, await back.file.text()]).toEqual([
      "note.txt",
      5,
      "z",
    ]);
  });

  it("errors come back as their kind, with what caused them", async () => {
    const back = (await carried(new RangeError("too far", { cause: new Date(1) }))) as Error;
    expect(back).toBeInstanceOf(RangeError);
    expect([back.message, back.cause]).toEqual(["too far", new Date(1)]);
  });

  it("a key that may leave the browser is made again, and signs as it did", async () => {
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [
      "sign",
      "verify",
    ]);
    const back = (await carried({ key })) as { key: CryptoKey };
    const message = new TextEncoder().encode("signed");
    const signature = await crypto.subtle.sign("HMAC", key, message);
    expect(await crypto.subtle.verify("HMAC", back.key, signature, message)).toBe(true);
    expect(back.key.usages).toEqual(key.usages);

    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const made = (await carried(pair.privateKey)) as CryptoKey;
    const signed = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, made, message);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        signed,
        message,
      ),
    ).toBe(true);
  });

  it("a key that may not leave the browser, and what is no data, is refused", async () => {
    const kept = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
    ]);
    await expect(stored.encode({ kept })).rejects.toThrow(/may not leave the browser/u);
    await expect(stored.encode(new WeakMap())).rejects.toThrow(/WeakMap is not carried/u);
  });
});
