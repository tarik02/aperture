import { Api, covers, CurrentCaller, Scope } from "@aperture-browser/control-api";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { accountOf } from "../accounts/caller.ts";
import { Accounts } from "../accounts/service.ts";
import { Forbidden } from "../errors.ts";
import { Events } from "../events/service.ts";
import { Grants } from "../grants/service.ts";
import { Identity } from "../identity/service.ts";
import { Nodes } from "../nodes/service.ts";
import { sessionPath } from "../routing/paths.ts";
import type { Session } from "../sessions/schemas.ts";
import { Sessions } from "../sessions/service.ts";
import { Settings } from "../settings/service.ts";
import { Shares } from "../shares/service.ts";
import { Snapshots } from "../snapshots/service.ts";
import { type Joined, Workspaces } from "../workspaces/service.ts";
import { originOf } from "./origin.ts";

/** Goes on for an admin, and for nobody else. */
const admin = Effect.gen(function* () {
  const caller = yield* CurrentCaller;
  if (!caller.admin) {
    return yield* new Forbidden({ message: "this is an admin's to do" });
  }
  return caller;
});

/** Goes on for a caller whose token covers the scope, with the caller. */
const scoped = (scope: Scope) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller;
    if (!covers(caller.scopes, scope)) {
      return yield* new Forbidden({ message: `this token is not for ${scope}` });
    }
    return caller;
  });

const lasting = (days: number | undefined) =>
  days === undefined ? undefined : Duration.days(days);

const accounts = HttpApiBuilder.group(
  Api,
  "accounts",
  Effect.fn(function* (handlers) {
    const accounts = yield* Accounts;
    return handlers
      .handle(
        "current",
        Effect.fn(function* () {
          const caller = yield* CurrentCaller;
          return yield* Option.match(caller.account, {
            onNone: () => Effect.fail(new Forbidden({ message: "this token is of no account" })),
            onSome: Effect.succeed,
          });
        }),
      )
      .handle("list", () => Effect.andThen(admin, accounts.list()))
      .handle("lookup", ({ query }) =>
        Effect.flatMap(scoped("workspaces:write"), (caller) =>
          accounts.lookup(caller, query.email),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.andThen(
          admin,
          accounts.create({
            name: payload.name,
            admin: payload.admin ?? false,
            kind: payload.kind ?? (payload.email === undefined ? "service" : "person"),
            email: payload.email,
          }),
        ),
      )
      .handle(
        "createToken",
        Effect.fn(function* ({ params, payload }) {
          yield* admin;
          const { token, secret } = yield* accounts.createToken(
            params.id,
            payload.name,
            lasting(payload.expiresInDays),
            payload.scopes,
            payload.resources,
          );
          return { ...token, token: secret };
        }),
      )
      .handle(
        "createSetupToken",
        Effect.fn(function* ({ params }) {
          yield* admin;
          return { token: yield* accounts.setupToken(params.id) };
        }),
      )
      .handle(
        "resetSecondFactor",
        Effect.fn(function* ({ params }) {
          yield* admin;
          yield* accounts.resetSecondFactor(params.id);
        }),
      )
      .handle("disable", ({ params }) =>
        Effect.flatMap(admin, (caller) => accounts.disable(caller, params.id)),
      )
      .handle("enable", ({ params }) => Effect.andThen(admin, accounts.enable(params.id)))
      .handle("remove", ({ params }) =>
        Effect.flatMap(admin, (caller) => accounts.remove(caller, params.id)),
      )
      .handle(
        "removePasskeys",
        Effect.fn(function* ({ params }) {
          yield* admin;
          yield* accounts.removePasskeys(params.id);
        }),
      )
      .handle("tokens", () => Effect.flatMap(scoped("tokens:write"), accounts.tokens))
      .handle(
        "createOwnToken",
        Effect.fn(function* ({ payload }) {
          const caller = yield* scoped("tokens:write");
          const account = yield* accountOf(caller);
          if (caller.resources !== null) {
            return yield* new Forbidden({
              message: "a token held to resources makes no tokens",
            });
          }
          // A token makes none that does more than itself.
          const beyond = payload.scopes.find((scope) => !covers(caller.scopes, scope));
          if (beyond !== undefined) {
            return yield* new Forbidden({ message: `this token is not for ${beyond} itself` });
          }
          const { token, secret } = yield* accounts
            .createToken(
              account.id,
              payload.name,
              lasting(payload.expiresInDays),
              payload.scopes,
              payload.resources,
            )
            .pipe(Effect.orDie);
          return { ...token, token: secret };
        }),
      )
      .handle("revokeToken", ({ params }) =>
        Effect.flatMap(scoped("tokens:write"), (caller) => accounts.revokeToken(caller, params.id)),
      );
  }),
);

const events = HttpApiBuilder.group(
  Api,
  "events",
  Effect.fn(function* (handlers) {
    const events = yield* Events;
    return handlers.handle(
      "list",
      Effect.fn(function* ({ query }) {
        const page = yield* events.list(yield* CurrentCaller, {
          ...query,
          since: query.since === undefined ? undefined : DateTime.toDate(query.since),
          until: query.until === undefined ? undefined : DateTime.toDate(query.until),
        });
        // Whose an event is, is what decides who reads it, and is told to nobody.
        return { ...page, events: page.events.map(({ ownerId: _, ...event }) => event) };
      }),
    );
  }),
);

/** The address a person's browser goes to with what they decided, as OAuth has it. */
const answered = (redirectUri: string, said: Readonly<Record<string, string | undefined>>) => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(said)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.toString();
};

const grants = HttpApiBuilder.group(
  Api,
  "grants",
  Effect.fn(function* (handlers) {
    const grants = yield* Grants;
    return handlers
      .handle("asking", ({ query }) =>
        grants
          .asking(query)
          .pipe(Effect.map((client) => ({ clientId: client.id, clientName: client.name }))),
      )
      .handle("list", () => Effect.flatMap(scoped("tokens:write"), grants.list))
      .handle(
        "approve",
        Effect.fn(function* ({ payload }) {
          const caller = yield* scoped("tokens:write");
          const code = yield* grants.approve(caller, {
            clientId: payload.clientId,
            redirectUri: payload.redirectUri,
            codeChallenge: payload.codeChallenge,
            scopes: payload.scopes,
            resources: payload.resources,
          });
          return { redirectTo: answered(payload.redirectUri, { code, state: payload.state }) };
        }),
      )
      .handle("revoke", ({ params }) =>
        Effect.flatMap(scoped("tokens:write"), (caller) => grants.revoke(caller, params.id)),
      );
  }),
);

const signIn = HttpApiBuilder.group(
  Api,
  "signIn",
  Effect.fn(function* (handlers) {
    const identity = yield* Identity;
    return handlers.handle("providers", () => identity.providers());
  }),
);

const nodes = HttpApiBuilder.group(
  Api,
  "nodes",
  Effect.fn(function* (handlers) {
    const nodes = yield* Nodes;
    return handlers
      .handle(
        "list",
        Effect.fn(function* () {
          yield* admin;
          const all = yield* nodes.list();
          return all.map(({ node, alive }) => ({
            id: node.id,
            name: node.name,
            internalUrl: node.internalUrl,
            balancerUrl: node.balancerUrl,
            publicUrl: node.publicUrl,
            offers: node.offers,
            registeredAt: node.registeredAt,
            lastSeenAt: node.lastSeenAt,
            alive,
          }));
        }),
      )
      .handle("registrationTokens", () => Effect.andThen(admin, nodes.registrationTokens()))
      .handle(
        "createRegistrationToken",
        Effect.fn(function* ({ payload }) {
          yield* admin;
          const { token, secret } = yield* nodes.createRegistrationToken(payload.name);
          return { ...token, token: secret };
        }),
      );
  }),
);

/** A session as the API tells it: with where a proxy before the nodes has it. */
export const told = (session: Session) => ({
  ...session,
  path: session.nodeId === null ? null : sessionPath(session.nodeId, session.id),
});

const sessions = HttpApiBuilder.group(
  Api,
  "sessions",
  Effect.fn(function* (handlers) {
    const sessions = yield* Sessions;
    return handlers
      .handle("list", () =>
        scoped("sessions:read").pipe(
          Effect.flatMap(sessions.list),
          Effect.map((all) => all.map(told)),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.create(caller, {
            suspended: payload.suspended ?? false,
            snapshotId: payload.snapshotId,
            label: payload.label,
            workspaceId: payload.workspaceId,
            proxy: payload.proxy,
            tags: payload.tags ?? {},
          }),
        ).pipe(Effect.map(told)),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(scoped("sessions:read"), (caller) => sessions.get(caller, params.id)).pipe(
          Effect.map(told),
        ),
      )
      .handle("describe", ({ params, payload }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.describe(caller, params.id, payload),
        ).pipe(Effect.map(told)),
      )
      .handle("proxy", ({ params }) =>
        Effect.flatMap(scoped("sessions:read"), (caller) => sessions.proxy(caller, params.id)).pipe(
          Effect.map((proxy) => ({ proxy })),
        ),
      )
      .handle("setProxy", ({ params, payload }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.setProxy(caller, params.id, payload.proxy),
        ).pipe(Effect.as(payload)),
      )
      .handle("suspend", ({ params }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.suspend(caller, params.id),
        ).pipe(Effect.map(told)),
      )
      .handle("resume", ({ params }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.resume(caller, params.id),
        ).pipe(Effect.map(told)),
      )
      .handle("delete", ({ params }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) => sessions.delete(caller, params.id)),
      )
      .handle("createTicket", ({ params, payload }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.admit(caller, params.id, {
            name: payload.name,
            access: payload.access ?? {},
          }),
        ),
      );
  }),
);

const shares = HttpApiBuilder.group(
  Api,
  "shares",
  Effect.fn(function* (handlers) {
    const shares = yield* Shares;
    const settings = yield* Settings;
    return handlers
      .handle("list", ({ params }) =>
        Effect.flatMap(scoped("sessions:read"), (caller) => shares.list(caller, params.id)),
      )
      .handle(
        "create",
        Effect.fn(function* ({ params, payload }) {
          const caller = yield* scoped("sessions:write");
          const { share, secret } = yield* shares.create(caller, params.id, {
            name: payload.name,
            role: payload.role,
            lasts:
              payload.expiresInHours === undefined
                ? undefined
                : Duration.hours(payload.expiresInHours),
          });
          const origin = originOf(settings, yield* HttpServerRequest.HttpServerRequest);
          // After the `#`, so the secret is sent nowhere when the link is opened.
          return { ...share, url: `${origin}/share/${share.id}#${secret}` };
        }),
      )
      .handle("revoke", ({ params }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          shares.revoke(caller, params.id, params.shareId),
        ),
      );
  }),
);

const snapshots = HttpApiBuilder.group(
  Api,
  "snapshots",
  Effect.fn(function* (handlers) {
    const snapshots = yield* Snapshots;
    return handlers
      .handle("list", () => Effect.flatMap(scoped("snapshots:read"), snapshots.list))
      .handle("take", ({ params, payload }) =>
        Effect.flatMap(scoped("snapshots:write"), (caller) =>
          snapshots.take(caller, params.id, {
            name: payload.name,
            description: payload.description,
            tags: payload.tags,
            replaces: payload.replaces,
          }),
        ),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(scoped("snapshots:read"), (caller) => snapshots.get(caller, params.id)),
      )
      .handle("describe", ({ params, payload }) =>
        Effect.flatMap(scoped("snapshots:write"), (caller) =>
          snapshots.describe(caller, params.id, payload),
        ),
      )
      .handle("delete", ({ params }) =>
        Effect.flatMap(scoped("snapshots:write"), (caller) => snapshots.delete(caller, params.id)),
      );
  }),
);

const workspaces = HttpApiBuilder.group(
  Api,
  "workspaces",
  Effect.fn(function* (handlers) {
    const workspaces = yield* Workspaces;
    const shown = ({ workspace, role }: Joined) => ({ ...workspace, role });
    return handlers
      .handle("list", () =>
        CurrentCaller.pipe(
          Effect.flatMap(workspaces.list),
          Effect.map((all) => all.map(shown)),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.flatMap(scoped("workspaces:write"), (caller) =>
          workspaces.create(caller, payload.name),
        ).pipe(Effect.map(shown)),
      )
      .handle("rename", ({ params, payload }) =>
        Effect.flatMap(scoped("workspaces:write"), (caller) =>
          workspaces.rename(caller, params.id, payload.name),
        ).pipe(Effect.map(shown)),
      )
      .handle("delete", ({ params }) =>
        Effect.flatMap(scoped("workspaces:write"), (caller) =>
          workspaces.delete(caller, params.id),
        ),
      )
      .handle("members", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => workspaces.members(caller, params.id)),
      )
      .handle("admit", ({ params, payload }) =>
        Effect.flatMap(scoped("workspaces:write"), (caller) =>
          workspaces.admit(caller, params.id, params.accountId, payload.role),
        ),
      )
      .handle("dismiss", ({ params }) =>
        Effect.flatMap(scoped("workspaces:write"), (caller) =>
          workspaces.dismiss(caller, params.id, params.accountId),
        ),
      );
  }),
);

export const layer = Layer.mergeAll(
  accounts,
  events,
  grants,
  nodes,
  sessions,
  shares,
  signIn,
  snapshots,
  workspaces,
);
