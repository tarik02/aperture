import * as IpInterface from "effect/net/IpInterface";
import * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/** How much of an IPv6 address is before the IPv4 one it stands for. */
const MAPPED_BITS = 96;

/**
 * A proxy whose word is taken, or a range of them, as a setting names it: `10.0.0.0/8`,
 * `fd00::/8`, `::1`. One of IPv4 that is written as IPv6 is the IPv4 one.
 */
export const network = (given: string) =>
  Result.map(IpInterface.fromString(given), (named) => {
    const mapped =
      NetAddress.isIpv6Address(named.address) && named.prefixLength >= MAPPED_BITS
        ? NetAddress.fromIpv4Mapped(named.address)
        : Option.none();
    return Option.match(mapped, {
      onNone: () => IpNetwork.fromInterface(named),
      onSome: (address) => IpNetwork.fromAddressUnsafe(address, named.prefixLength - MAPPED_BITS),
    });
  });

/** An address as it is compared: an IPv4 one that came over IPv6 is the IPv4 one. */
const read = (address: string): Option.Option<NetAddress.IpAddress> =>
  Option.map(Result.getSuccess(NetAddress.ipFromString(address.trim())), (one) =>
    NetAddress.toCanonical(one),
  );

/** An address as it is told: in the one way it is written, where it is one at all. */
const plain = (address: string) =>
  Option.match(read(address), {
    onNone: () => address.trim().toLowerCase(),
    onSome: NetAddress.formatIp,
  });

/** Whether an address is one of the proxies whose word is taken. */
const trusts = (trusted: ReadonlyArray<IpNetwork.IpNetwork>, address: string) =>
  Option.exists(read(address), (asked) => trusted.some(IpNetwork.contains(asked)));

/**
 * Where a request came from. A connection from a trusted proxy is the proxy's word for
 * it: of those `X-Forwarded-For` names, the last that is no trusted proxy itself, since
 * anything before it is only what that one said. Any other connection is where it came
 * from, whatever the request says.
 */
export const clientAddress = (
  trusted: ReadonlyArray<IpNetwork.IpNetwork>,
  remote: Option.Option<string>,
  forwardedFor: string | undefined,
): Option.Option<string> => {
  if (Option.isNone(remote) || !trusts(trusted, remote.value)) {
    return Option.map(remote, plain);
  }
  const named = (forwardedFor ?? "").split(",").filter((one) => one.trim() !== "");
  return Option.some(plain(named.findLast((one) => !trusts(trusted, one)) ?? remote.value));
};
