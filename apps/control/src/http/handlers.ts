import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Accounts } from "../accounts/service.ts";
import { Api, CurrentCaller } from "../api.ts";
import { Forbidden } from "../errors.ts";
import { Nodes } from "../nodes/service.ts";
import { Sessions } from "../sessions/service.ts";

/** Goes on for an admin, and for nobody else. */
const admin = Effect.gen(function* () {
  const caller = yield* CurrentCaller;
  if (!caller.admin) {
    return yield* new Forbidden({ message: "this is an admin's to do" });
  }
  return caller;
});

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
          const { token, secret } = yield* accounts.createToken(params.id, payload.name);
          return { ...token, token: secret };
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

const sessions = HttpApiBuilder.group(
  Api,
  "sessions",
  Effect.fn(function* (handlers) {
    const sessions = yield* Sessions;
    return handlers
      .handle("list", () => Effect.flatMap(CurrentCaller, sessions.list))
      .handle("create", ({ payload }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          sessions.create(caller, { suspended: payload.suspended ?? false }),
        ),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.get(caller, params.id)),
      )
      .handle("suspend", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.suspend(caller, params.id)),
      )
      .handle("resume", ({ params }) =>
        Effect.flatMap(CurrentCaller, (caller) => sessions.resume(caller, params.id)),
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

export const layer = Layer.mergeAll(accounts, nodes, sessions);
