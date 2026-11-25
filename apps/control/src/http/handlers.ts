import { type Access, Api, covers, CurrentCaller, Scope } from "@aperture-browser/control-api";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import manifest from "../../package.json" with { type: "json" };
import { accountOf } from "../accounts/caller.ts";
import { Accounts } from "../accounts/service.ts";
import { Forbidden } from "../errors.ts";
import { Doer } from "../events/doer.ts";
import { anonymous } from "../events/schemas.ts";
import { Events } from "../events/service.ts";
import { Grants } from "../grants/service.ts";
import { Identity } from "../identity/service.ts";
import { Nodes } from "../nodes/service.ts";
import { Providers } from "../providers/service.ts";
import { sessionPath } from "../routing/paths.ts";
import type { Session } from "../sessions/schemas.ts";
import { Sessions } from "../sessions/service.ts";
import { Settings } from "../settings/service.ts";
import { Shares } from "../shares/service.ts";
import type { Snapshot } from "../snapshots/schemas.ts";
import { Snapshots } from "../snapshots/service.ts";
import { type Joined, Workspaces } from "../workspaces/service.ts";
import { doing } from "./doer.ts";
import { originOf } from "./origin.ts";

/** What a list is asked by for what is of no workspace. */
const NO_WORKSPACE = "none";

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

/** Where the request says it came to, for the addresses that are told in answer to it. */
const origin = Effect.gen(function* () {
  return originOf(yield* Settings, yield* HttpServerRequest.HttpServerRequest);
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
          if (Option.isNone(caller.account)) {
            return yield* new Forbidden({ message: "this token is of no account" });
          }
          return { ...caller.account.value, scopes: caller.scopes, resources: caller.resources };
        }),
      )
      .handle("list", () => Effect.andThen(admin, accounts.list()))
      .handle("get", ({ params }) => Effect.andThen(admin, accounts.get(params.id)))
      .handle("change", ({ params, payload }) =>
        Effect.flatMap(admin, (caller) => accounts.change(caller, params.id, payload)),
      )
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
          const caller = yield* admin;
          const { token, secret } = yield* accounts.createToken(
            params.id,
            payload.name,
            lasting(payload.expiresInDays),
            payload.scopes,
            payload.resources,
            undefined,
            // A token that runs out makes none that outlives it.
            caller.expiresAt,
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
              undefined,
              // Nor one that outlives it.
              caller.expiresAt,
            )
            .pipe(Effect.orDie);
          return { ...token, token: secret };
        }),
      )
      .handle("revokeToken", ({ params }) =>
        Effect.flatMap(scoped("tokens:write"), (caller) => accounts.revokeToken(caller, params.id)),
      )
      .handle("tokensOf", ({ params }) => Effect.andThen(admin, accounts.tokensOf(params.id)))
      .handle("revokeTokenOf", ({ params }) =>
        Effect.andThen(admin, accounts.revokeTokenOf(params.id, params.tokenId)),
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

const providers = HttpApiBuilder.group(
  Api,
  "providers",
  Effect.fn(function* (handlers) {
    const providers = yield* Providers;
    const identity = yield* Identity;
    const settings = yield* Settings;
    return handlers
      .handle(
        "list",
        Effect.fn(function* () {
          yield* admin;
          const origin = originOf(settings, yield* HttpServerRequest.HttpServerRequest);
          return {
            callbackBase: `${origin}${identity.path}/callback/`,
            providers: yield* providers.list(),
          };
        }),
      )
      .handle("create", ({ payload }) => Effect.andThen(admin, providers.create(payload)))
      .handle("check", ({ payload }) =>
        Effect.andThen(
          admin,
          providers.check(
            payload.endpoints === undefined
              ? { issuer: payload.issuer ?? "" }
              : { endpoints: payload.endpoints },
          ),
        ),
      )
      .handle("change", ({ params, payload }) =>
        Effect.andThen(admin, providers.change(params.id, payload)),
      )
      .handle("remove", ({ params }) => Effect.andThen(admin, providers.remove(params.id)));
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

const firstAdmin = HttpApiBuilder.group(
  Api,
  "firstAdmin",
  Effect.fn(function* (handlers) {
    const accounts = yield* Accounts;
    const settings = yield* Settings;
    return handlers
      .handle("awaited", () =>
        Effect.map(accounts.firstAdminLink(), (link) => ({ awaited: Option.isSome(link) })),
      )
      .handle(
        "create",
        Effect.fn(function* ({ payload: { token, ...person } }) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Whoever has the link is nobody yet: they are told by where they came from.
          return yield* accounts
            .firstAdmin(token, person)
            .pipe(Effect.provideService(Doer, doing(settings, request, anonymous(person.email))));
        }),
      );
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
      .handle("release", ({ params }) => Effect.andThen(admin, nodes.release(params.id)))
      .handle("registrationTokens", () => Effect.andThen(admin, nodes.registrationTokens()))
      .handle(
        "createRegistrationToken",
        Effect.fn(function* ({ payload }) {
          yield* admin;
          const { token, secret } = yield* nodes.createRegistrationToken(payload.name);
          return { ...token, token: secret };
        }),
      )
      .handle("revokeRegistrationToken", ({ params }) =>
        Effect.andThen(admin, nodes.revokeRegistrationToken(params.id)),
      );
  }),
);

/**
 * A session as the API tells it: with what its node is called, and where a proxy before
 * the nodes has it.
 */
const told = (session: Session, nodeName: string | null) => ({
  ...session,
  nodeName,
  path: session.nodeId === null ? null : sessionPath(session.nodeId, session.id),
});

/**
 * Tells sessions as the API does. Whoever has a session learns what its node is called,
 * and nothing else of the node.
 */
export const telling = Effect.gen(function* () {
  const nodes = yield* Nodes;
  const all = Effect.fn(function* (sessions: ReadonlyArray<Session>) {
    const names = new Map((yield* nodes.list()).map(({ node }) => [node.id, node.name]));
    return sessions.map((session) =>
      told(session, session.nodeId === null ? null : (names.get(session.nodeId) ?? null)),
    );
  });
  const one = Effect.fn(function* (session: Session) {
    const node = session.nodeId === null ? Option.none() : yield* nodes.find(session.nodeId);
    return told(session, Option.isSome(node) ? node.value.name : null);
  });
  return { one, all };
});

/** A tag as a list is asked by one: `name=value`, or `name` for whatever it is set to. */
const tagged = (tags: Readonly<Record<string, string>>, asked: string) => {
  const at = asked.indexOf("=");
  return at === -1 ? asked in tags : tags[asked.slice(0, at)] === asked.slice(at + 1);
};

/** Whose something is, as a list is asked by it: a workspace's, or `none` for no workspace's. */
const inWorkspace = (workspaceId: string | null, asked: string) =>
  asked === NO_WORKSPACE ? workspaceId === null : workspaceId === asked;

/** What a list of sessions is narrowed to, as the API and the tools ask for it alike. */
export interface SessionsAsked {
  readonly workspaceId?: string | undefined;
  readonly state?: Session["observedState"] | undefined;
  /** A part of the label, whatever its letters' case. */
  readonly label?: string | undefined;
  readonly tag?: string | undefined;
}

export const sessionsAsked = (asked: SessionsAsked) => (session: Session) =>
  (asked.workspaceId === undefined || inWorkspace(session.workspaceId, asked.workspaceId)) &&
  (asked.state === undefined || session.observedState === asked.state) &&
  (asked.label === undefined ||
    (session.label ?? "").toLowerCase().includes(asked.label.toLowerCase())) &&
  (asked.tag === undefined || tagged(session.tags, asked.tag));

export interface SnapshotsAsked {
  readonly workspaceId?: string | undefined;
  /** A part of the name, whatever its letters' case. */
  readonly name?: string | undefined;
  readonly tag?: string | undefined;
}

export const snapshotsAsked = (asked: SnapshotsAsked) => (snapshot: Snapshot) =>
  (asked.workspaceId === undefined || inWorkspace(snapshot.workspaceId, asked.workspaceId)) &&
  (asked.name === undefined ||
    (snapshot.name ?? "").toLowerCase().includes(asked.name.toLowerCase())) &&
  (asked.tag === undefined || tagged(snapshot.tags, asked.tag));

/**
 * What a token has to be for to be given a ticket: one with no access watches, as a token
 * that reads sessions does wherever it reaches one, and any other does what writing does.
 */
export const ticketScope = (access: Access): Scope =>
  Object.values(access).some((given) => given !== undefined) ? "sessions:write" : "sessions:read";

const sessions = HttpApiBuilder.group(
  Api,
  "sessions",
  Effect.fn(function* (handlers) {
    const sessions = yield* Sessions;
    const tell = yield* telling;
    return handlers
      .handle("list", ({ query }) =>
        scoped("sessions:read").pipe(
          Effect.flatMap(sessions.list),
          Effect.map((all) => all.filter(sessionsAsked(query))),
          Effect.flatMap(tell.all),
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
            storageState: payload.storageState,
          }),
        ).pipe(Effect.flatMap(tell.one)),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(scoped("sessions:read"), (caller) => sessions.get(caller, params.id)).pipe(
          Effect.flatMap(tell.one),
        ),
      )
      .handle("describe", ({ params, payload }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.describe(caller, params.id, payload),
        ).pipe(Effect.flatMap(tell.one)),
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
        ).pipe(Effect.flatMap(tell.one)),
      )
      .handle("resume", ({ params }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) =>
          sessions.resume(caller, params.id),
        ).pipe(Effect.flatMap(tell.one)),
      )
      .handle("delete", ({ params }) =>
        Effect.flatMap(scoped("sessions:write"), (caller) => sessions.delete(caller, params.id)),
      )
      .handle(
        "createTicket",
        Effect.fn(function* ({ params, payload }) {
          const access = payload.access ?? {};
          const caller = yield* scoped(ticketScope(access));
          return yield* sessions.admit(
            caller,
            params.id,
            { name: payload.name, access },
            yield* origin,
          );
        }),
      )
      .handle(
        "createFileLink",
        Effect.fn(function* ({ params, payload }) {
          const caller = yield* scoped("sessions:write");
          return yield* sessions.fileLink(
            caller,
            params.id,
            {
              path: payload.path,
              write: payload.write ?? false,
              lasts:
                payload.expiresInSeconds === undefined
                  ? undefined
                  : Duration.seconds(payload.expiresInSeconds),
            },
            yield* origin,
          );
        }),
      );
  }),
);

/** What a guest opens: the secret after the `#`, so it is sent nowhere when the link is. */
export const shareUrl = (origin: string, id: string, secret: string) =>
  `${origin}/share/${id}#${secret}`;

const shares = HttpApiBuilder.group(
  Api,
  "shares",
  Effect.fn(function* (handlers) {
    const shares = yield* Shares;
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
          return { ...share, url: shareUrl(yield* origin, share.id, secret) };
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
      .handle("list", ({ query }) =>
        scoped("snapshots:read").pipe(
          Effect.flatMap(snapshots.list),
          Effect.map((all) => all.filter(snapshotsAsked(query))),
        ),
      )
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
        Effect.flatMap(scoped("workspaces:read"), (caller) =>
          workspaces.members(caller, params.id),
        ),
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
      )
      .handle("ofAccount", ({ params }) =>
        Effect.andThen(admin, workspaces.ofAccount(params.accountId)).pipe(
          Effect.map((all) => all.map(({ workspace, role }) => ({ ...workspace, role }))),
        ),
      );
  }),
);

const about = HttpApiBuilder.group(Api, "about", (handlers) =>
  handlers.handle("get", () => Effect.succeed({ version: manifest.version })),
);

const health = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("check", () => Effect.succeed({ status: "ok" as const })),
);

export const layer = Layer.mergeAll(
  about,
  accounts,
  events,
  firstAdmin,
  grants,
  health,
  nodes,
  providers,
  sessions,
  shares,
  signIn,
  snapshots,
  workspaces,
);
