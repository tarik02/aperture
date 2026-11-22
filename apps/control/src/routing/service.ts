import type { Caller } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Forbidden, SessionElsewhere, SessionHasNoNode, SessionNotFound } from "../errors.ts";

/** What a Traefik takes from its HTTP provider: the part of it this program writes. */
export interface ProxyConfig {
  readonly http: {
    readonly routers: Record<string, unknown>;
    readonly middlewares: Record<string, unknown>;
    readonly services: Record<string, unknown>;
  };
}

/**
 * Sessions behind a proxy that stands before the nodes: the proxy sends what comes to a
 * node's path on to the node, once it was told here that the request may pass.
 */
export interface RoutingShape {
  /**
   * Lets a request to a session's path pass: a ticket into the session for the caller,
   * which the proxy puts on the request it sends to the node. The ticket goes no further
   * than the proxy.
   */
  readonly admit: (
    caller: Caller,
    uri: string,
  ) => Effect.Effect<string, Forbidden | SessionNotFound | SessionHasNoNode | SessionElsewhere>;
  /**
   * Lets a request pass that carries a ticket of its own, as its bearer token or as `token`
   * in its query: a link someone was given to a session or to one file of it, or what a
   * program was handed to reach one part of a session with. The ticket itself, where it was
   * signed here, is still good and is into the session the request asks for on the node it
   * asks at; what it gives there is the node's to say. Nothing, for any other request.
   */
  readonly admitTicket: (
    uri: string,
    bearer: Option.Option<string>,
  ) => Effect.Effect<Option.Option<string>>;
  /** The routes to the nodes that are alive, and to this program, as Traefik reads them. */
  readonly proxyConfig: () => Effect.Effect<ProxyConfig>;
}

export class Routing extends Context.Service<Routing, RoutingShape>()(
  "@aperture-browser/control/Routing",
) {}
