import { PREFIX, type Access, type Caller, covers } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { accountOf } from "../accounts/caller.ts";
import { Forbidden, SessionElsewhere, SessionNotFound } from "../errors.ts";
import { Nodes } from "../nodes/service.ts";
import { Sessions } from "../sessions/service.ts";
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

export const makeRouting = Effect.fn("Routing.make")(function* () {
  const nodes = yield* Nodes;
  const sessions = yield* Sessions;
  const tickets = yield* Tickets;
  const settings = yield* Settings;

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
        },
        middlewares: {
          [ADMIT]: {
            forwardAuth: {
              address: `${settings.internalUrl}${ADMIT_PATH}`,
              authResponseHeaders: ["Authorization"],
            },
          },
          [FORGET]: { headers: { customRequestHeaders: { Cookie: "" } } },
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

  return Routing.of({ admit, proxyConfig });
});

export const layer = Layer.effect(Routing, makeRouting());
