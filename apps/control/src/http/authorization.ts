import { Authorization, CurrentCaller } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { Accounts } from "../accounts/service.ts";
import { callerOf } from "./caller.ts";

export const layer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    return Authorization.of({
      // The token is one way to say who comes, and the request is read for the others:
      // a browser that signed in carries cookies and no token.
      bearer: Effect.fn(function* (handled) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const caller = yield* callerOf(accounts, request);
        return yield* Effect.provideService(handled, CurrentCaller, caller);
      }),
    });
  }),
);
