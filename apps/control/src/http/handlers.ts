import { Api, CurrentCaller } from "@aperture-browser/control-api";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { accountOf } from "../accounts/caller.ts";
import { Accounts } from "../accounts/service.ts";
import { Forbidden } from "../errors.ts";
import { Nodes } from "../nodes/service.ts";
import { sessionPath } from "../routing/paths.ts";
import type { Session } from "../sessions/schemas.ts";
import { Sessions } from "../sessions/service.ts";
import { Snapshots } from "../snapshots/service.ts";

/** Goes on for an admin, and for nobody else. */
const admin = Effect.gen(function* () {
  const caller = yield* CurrentCaller;
  if (!caller.admin) {
    return yield* new Forbidden({ message: "this is an admin's to do" });
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
      .handle("create", ({ payload }) =>
        Effect.andThen(
          admin,
          accounts.create({ name: payload.name, admin: payload.admin ?? false }),
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
          );
          return { ...token, token: secret };
        }),
      )
      .handle("tokens", () => Effect.flatMap(CurrentCaller, accounts.tokens))
      .handle(
        "createOwnToken",
        Effect.fn(function* ({ payload }) {
          const account = yield* accountOf(yield* CurrentCaller);
          const { token, secret } = yield* accounts
            .createToken(account.id, payload.name, lasting(payload.expiresInDays))
            .pipe(Effect.orDie);
          return { ...token, token: secret };
        }),
      )
      .handle("revokeToken", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => accounts.revokeToken(caller, params.id)),
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
const told = (session: Session) => ({
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
        CurrentCaller.pipe(
          Effect.flatMap(sessions.list),
          Effect.map((all) => all.map(told)),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          sessions.create(caller, {
            suspended: payload.suspended ?? false,
            snapshotId: payload.snapshotId,
            label: payload.label,
            tags: payload.tags ?? [],
          }),
        ).pipe(Effect.map(told)),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.get(caller, params.id)).pipe(
          Effect.map(told),
        ),
      )
      .handle("describe", ({ params, payload }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          sessions.describe(caller, params.id, payload),
        ).pipe(Effect.map(told)),
      )
      .handle("suspend", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.suspend(caller, params.id)).pipe(
          Effect.map(told),
        ),
      )
      .handle("resume", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.resume(caller, params.id)).pipe(
          Effect.map(told),
        ),
      )
      .handle("delete", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.delete(caller, params.id)),
      )
      .handle("createTicket", ({ params, payload }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          sessions.admit(caller, params.id, {
            name: payload.name,
            access: payload.access ?? {},
          }),
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
      .handle("list", () => Effect.flatMap(CurrentCaller, snapshots.list))
      .handle("take", ({ params, payload }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          snapshots.take(caller, params.id, {
            name: payload.name,
            description: payload.description,
            tags: payload.tags ?? [],
          }),
        ),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => snapshots.get(caller, params.id)),
      )
      .handle("describe", ({ params, payload }) =>
        Effect.flatMap(CurrentCaller, (caller) => snapshots.describe(caller, params.id, payload)),
      )
      .handle("delete", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => snapshots.delete(caller, params.id)),
      );
  }),
);

export const layer = Layer.mergeAll(accounts, nodes, sessions, snapshots);
