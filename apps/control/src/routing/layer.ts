import { PREFIX, type Access, type Caller, covers } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { accountOf } from "../accounts/caller.ts";
import { Forbidden, SessionElsewhere, SessionNotFound } from "../errors.ts";
import { Nodes } from "../nodes/service.ts";
import { Sessions } from "../sessions/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { Settings } from "../settings/service.ts";
import { Tickets } from "../tickets/service.ts";
import { nodePath, sessionAt, sessionPath } from "./paths.ts";
import { type ProxyConfig, Routing } from "./service.ts";

/** Whoever comes through the proxy comes as the session's owner, to whom nothing of it is closed. */
const EVERYTHING: Access = {
  input: "rw",
  tabs: "rw",
  lease: "rw",
  sound: "rw",
  clipboard: "rw",
  uploads: "rw",
  downloads: "rw",
  recordings: "rw",
  proxy: "rw",
  mcp: "rw",
  cdp: "rw",
  tunnel: "rw",
};

/** Where the proxy asks whether a request may pass. */
export const ADMIT_PATH = `${PREFIX}/route/admit`;

const ADMIT = "aperture-admit";
const FORGET = "aperture-forget";
const CONTROL = "aperture-control";
const WHOLE = "aperture-whole";
/** How much of what is asked of a session's automation the proxy keeps in memory. */
const WHOLE_IN_MEMORY = 1024 * 1024;

export const makeRouting = Effect.fn("Routing.make")(function* () {
  const nodes = yield* Nodes;
  const sessions = yield* Sessions;
  const tickets = yield* Tickets;
  const settings = yield* Settings;
  const store = yield* SessionsStore;

  const admitTicket = Effect.fn("Routing.admitTicket")(function* (
    uri: string,
    bearer: Option.Option<string>,
  ) {
    const at = sessionAt(uri);
    // As a session takes one itself: on the request, or in its address.
    const given =
      Option.getOrNull(bearer) ?? new URLSearchParams(uri.split("?")[1] ?? "").get("token");
    // An API token is no ticket, and is not looked at as one.
    if (at === undefined || given === null || given.split(".").length !== 3) {
      return Option.none<string>();
    }
    const into = yield* tickets.sessionOf(given);
    if (Option.isNone(into) || into.value !== at.sessionId) {
      return Option.none<string>();
    }
    // The session is where the request asks for it, or the ticket is into nothing there.
    const session = yield* store.find(at.sessionId);
    return Option.isSome(session) && session.value.nodeId === at.nodeId
      ? Option.some(given)
      : Option.none<string>();
  });

  const admit = Effect.fn("Routing.admit")(function* (caller: Caller, uri: string) {
    const at = sessionAt(uri);
    if (at === undefined) {
      return yield* new SessionNotFound({ id: uri });
    }
    if (!covers(caller.scopes, "sessions:read")) {
      return yield* new Forbidden({ message: "this token is not for sessions" });
    }
    const account = yield* accountOf(caller);
    const { node } = yield* sessions.placed(caller, at.sessionId);
    if (node.id !== at.nodeId) {
      return yield* new SessionElsewhere({
        id: at.sessionId,
        path: sessionPath(node.id, at.sessionId),
      });
    }
    const issued = yield* tickets.issue({
      sessionId: at.sessionId,
      subject: account.id,
      name: account.name,
      // A token that only reads sessions watches, and gives no input.
      access: covers(caller.scopes, "sessions:write") ? EVERYTHING : {},
    });
    return issued.ticket;
  });

  const proxyConfig = Effect.fn("Routing.proxyConfig")(function* () {
    const alive = yield* nodes.alive();
    const named = alive.map((node) => ({ node, name: `aperture-node-${node.id}` }));
    return {
      http: {
        routers: {
          // The shortest rule, so every other one is tried before it: the API and, where
          // this program serves it, the console.
          [CONTROL]: { rule: "PathPrefix(`/`)", service: CONTROL },
          ...Object.fromEntries(
            named.map(({ node, name }) => [
              name,
              {
                rule: `PathPrefix(\`${nodePath(node.id)}/\`)`,
                service: name,
                // In this order: who comes is told by what the request carries, which
                // the node is not sent.
                middlewares: [ADMIT, FORGET, name],
              },
            ]),
          ),
          // The longer rule, so it is tried before the node's other one. What is asked of
          // a session's automation is taken whole before it is sent on, and so is the
          // answer: it is a stream that may start at once, and the proxy cuts short one
          // that starts while it is still reading what was asked from whoever asked.
          ...Object.fromEntries(
            named.map(({ node, name }) => [
              `${name}-mcp`,
              {
                // Asked with POST alone: what is listened to with GET never ends, and
                // would be kept from whoever listens for as long.
                rule: `PathRegexp(\`^${nodePath(node.id)}/sessions/[^/]+/mcp$\`) && Method(\`POST\`)`,
                service: name,
                middlewares: [ADMIT, FORGET, name, WHOLE],
              },
            ]),
          ),
        },
        middlewares: {
          [ADMIT]: {
            forwardAuth: {
              address: `${settings.internalUrl}${ADMIT_PATH}`,
              authResponseHeaders: ["Authorization"],
            },
          },
          [FORGET]: { headers: { customRequestHeaders: { Cookie: "" } } },
          [WHOLE]: { buffering: { memRequestBodyBytes: WHOLE_IN_MEMORY } },
          ...Object.fromEntries(
            named.map(({ node, name }) => [
              name,
              { stripPrefix: { prefixes: [nodePath(node.id)] } },
            ]),
          ),
        },
        services: {
          [CONTROL]: { loadBalancer: { servers: [{ url: settings.internalUrl }] } },
          ...Object.fromEntries(
            named.map(({ node, name }) => [
              name,
              { loadBalancer: { servers: [{ url: node.balancerUrl ?? node.internalUrl }] } },
            ]),
          ),
        },
      },
    } satisfies ProxyConfig;
  });

  return Routing.of({ admit, admitTicket, proxyConfig });
});

export const layer = Layer.effect(Routing, makeRouting());
