import * as Option from "effect/Option";

const OCTETS = 4;
const BITS = 32;
const BYTE = 256;

/** An IPv4 address as a number; nothing for what is none. */
const ipv4 = (address: string) => {
  const parts = address.split(".");
  if (parts.length !== OCTETS) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    const octet = /^\d{1,3}$/u.test(part) ? Number(part) : BYTE;
    if (octet >= BYTE) {
      return undefined;
    }
    value = value * BYTE + octet;
  }
  return value;
};

/** An address as it is compared: an IPv4 one that came over IPv6 is the IPv4 one. */
const plain = (address: string) =>
  address
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/u, "");

/** Whether an address is one of the proxies whose word is taken. */
const trusts = (trusted: ReadonlyArray<string>, address: string) => {
  const asked = plain(address);
  const number = ipv4(asked);
  return trusted.some((one) => {
    const [range = "", prefix] = plain(one).split("/");
    const base = ipv4(range);
    if (prefix === undefined || base === undefined || number === undefined) {
      return range === asked;
    }
    const kept = Number(prefix);
    if (!Number.isInteger(kept) || kept < 0 || kept > BITS) {
      return false;
    }
    const size = 2 ** (BITS - kept);
    return Math.floor(base / size) === Math.floor(number / size);
  });
};

/**
 * Where a request came from. A connection from a trusted proxy is the proxy's word for
 * it: of those `X-Forwarded-For` names, the last that is no trusted proxy itself, since
 * anything before it is only what that one said. Any other connection is where it came
 * from, whatever the request says.
 */
export const clientAddress = (
  trusted: ReadonlyArray<string>,
  remote: Option.Option<string>,
  forwardedFor: string | undefined,
): Option.Option<string> => {
  if (Option.isNone(remote) || !trusts(trusted, remote.value)) {
    return Option.map(remote, plain);
  }
  const named = (forwardedFor ?? "")
    .split(",")
    .map(plain)
    .filter((one) => one !== "");
  return Option.some(named.findLast((one) => !trusts(trusted, one)) ?? plain(remote.value));
};
