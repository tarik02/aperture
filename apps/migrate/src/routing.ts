import type { ProxyConfig } from "@aperture-browser/control-api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Routing } from "./v1/schemas.ts";

const decode = Schema.decodeUnknownOption(Routing);

/**
 * Whether v2 reads a rule's match as v1 did. Both take `host` and `host:port` with an
 * exact host, `*.suffix` or `*`; v1 took an IPv6 address as a host as well, in brackets
 * where a port follows, and v2 takes what follows the last colon of anything for a port.
 */
const matchable = (match: string) => !match.includes("[") && match.split(":").length <= 2;

/** A session's routing of v1 as v2 has it, and the rules of it v2 has no way to say. */
export interface Routed {
  /** None for a session whose connections all go direct. */
  readonly proxy: ProxyConfig | null;
  /** The matches of the rules that are left out. */
  readonly left: ReadonlyArray<string>;
}

/**
 * v1's routing of a session as v2's. The two are written alike: upstreams by name, each a
 * proxy's URL or a tunnel's with its secret, and rules in order, each a match and where
 * its connections go. Nothing for what cannot be read as that.
 */
export const routingOf = (kept: string | null): Routed | undefined => {
  if (kept === null) {
    return { proxy: null, left: [] };
  }
  return Option.getOrUndefined(
    decode(kept).pipe(
      Option.map(({ upstreams = {}, rules = [] }) => {
        const said = rules.filter((rule) => matchable(rule.match));
        const names = Object.keys(upstreams);
        return {
          proxy:
            said.length === 0 && names.length === 0
              ? null
              : { ...(names.length === 0 ? {} : { upstreams }), rules: said },
          left: rules.filter((rule) => !matchable(rule.match)).map((rule) => rule.match),
        };
      }),
    ),
  );
};
