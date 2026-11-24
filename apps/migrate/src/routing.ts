import type { ProxyConfig } from "@aperture-browser/control-api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Routing } from "./v1/schemas.ts";

const decode = Schema.decodeUnknownOption(Routing);

/** A session's routing of v1 as v2 has it. */
export interface Routed {
  /** None for a session whose connections all go direct. */
  readonly proxy: ProxyConfig | null;
}

/**
 * v1's routing of a session as v2's. The two are written alike: upstreams by name, each a
 * proxy's URL or a tunnel's with its secret, and rules in order, each a match and where
 * its connections go. A match is read by v2 as v1 read it: `host` and `host:port` with an
 * exact host, `*.suffix` or `*`, and an IPv6 address in brackets where a port follows.
 * Nothing for what cannot be read as that.
 */
export const routingOf = (kept: string | null): Routed | undefined => {
  if (kept === null) {
    return { proxy: null };
  }
  return Option.getOrUndefined(
    decode(kept).pipe(
      Option.map(({ upstreams = {}, rules = [] }) => {
        const names = Object.keys(upstreams);
        return {
          proxy:
            rules.length === 0 && names.length === 0
              ? null
              : { ...(names.length === 0 ? {} : { upstreams }), rules },
        };
      }),
    ),
  );
};
