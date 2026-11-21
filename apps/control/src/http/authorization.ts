import { Authorization, CurrentCaller } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Accounts } from "../accounts/service.ts";

export const layer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    return Authorization.of({
      bearer: Effect.fn(function* (handled, { credential }) {
        const caller = yield* accounts.identify(Redacted.value(credential));
        return yield* Effect.provideService(handled, CurrentCaller, caller);
      }),
    });
  }),
);
