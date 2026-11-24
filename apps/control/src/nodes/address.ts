import * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/** This machine, as an address names it. */
const HERE = ["127.0.0.0/8", "::1/128"].map(IpNetwork.fromStringUnsafe);

/**
 * Where no node is: the addresses a machine has for its own link alone, where clouds
 * answer a machine about itself, and the ones that are no address of anything.
 */
const NOWHERE = ["169.254.0.0/16", "fe80::/10", "0.0.0.0/8", "::/128"].map(
  IpNetwork.fromStringUnsafe,
);

const ipOf = (host: string) =>
  Option.map(Result.getSuccess(NetAddress.ipFromString(host.replace(/^\[|\]$/gu, ""))), (address) =>
    NetAddress.toCanonical(address),
  );

const within = (networks: ReadonlyArray<IpNetwork.IpNetwork>, host: string) =>
  Option.exists(ipOf(host), (address) => networks.some(IpNetwork.contains(address)));

const here = (host: string) =>
  within(HERE, host) || host === "localhost" || host.endsWith(".localhost");

export interface Asked {
  /** What the address is of, for telling why it is refused. */
  readonly what: string;
  /** Where the node's keepalive came from, as far as that is known. */
  readonly from: string | null;
  /**
   * Whether the address may have a path: one that people are sent to may, and one that
   * requests are made to is a scheme and a host.
   */
  readonly path?: boolean;
}

/**
 * An address a node says it is at, as it is kept: or why it is none. The control plane
 * and its proxy make requests to where a node says it is, with what lets them into the
 * node, so a node is not let say anything: an address with someone's name and password
 * in it, a query, the address a cloud tells a machine its secrets at. This machine is
 * where a node is only if it asks from this machine.
 */
export const address = (given: string, asked: Asked): Result.Result<string, string> => {
  const refused = (why: string) => Result.fail(`${asked.what} ${why}: ${given}`);
  const url = URL.canParse(given) ? new URL(given) : undefined;
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return refused("is no http address");
  }
  if (url.username !== "" || url.password !== "") {
    return refused("names who asks, which an address of a node does not");
  }
  if (url.search !== "" || url.hash !== "") {
    return refused("has more than where the node is");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (path !== "" && asked.path !== true) {
    return refused("has a path, and a node is reached at a scheme and a host");
  }
  if (within(NOWHERE, url.hostname)) {
    return refused("is where no node is");
  }
  if (here(url.hostname) && (asked.from === null || !here(asked.from))) {
    return refused("is the machine that is asked, and the node asks from another");
  }
  return Result.succeed(`${url.origin}${path}`);
};
