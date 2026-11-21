import * as Effect from "effect/Effect";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_MS = 30_000;
const TOTP_DIGITS = 6;

/** The code an authenticator shows now for the secret of an `otpauth:` address (RFC 6238). */
export const totp = (uri: string) =>
  Effect.promise(async () => {
    const secret = new URL(uri).searchParams.get("secret") ?? "";
    let bits = "";
    for (const letter of secret) {
      bits += BASE32.indexOf(letter).toString(2).padStart(5, "0");
    }
    const key = Uint8Array.from(bits.match(/.{8}/gu) ?? [], (byte) => Number.parseInt(byte, 2));
    const counter = new DataView(new ArrayBuffer(8));
    counter.setBigUint64(0, BigInt(Math.floor(Date.now() / TOTP_PERIOD_MS)));
    const signing = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const mac = new DataView(await crypto.subtle.sign("HMAC", signing, counter));
    const offset = mac.getUint8(mac.byteLength - 1) & 0x0f;
    const code = (mac.getUint32(offset) & 0x7fff_ffff) % 10 ** TOTP_DIGITS;
    return String(code).padStart(TOTP_DIGITS, "0");
  });
