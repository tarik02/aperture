import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Grants } from "./service.ts";

/** How often what is good for nothing is looked for: it is in nobody's way meanwhile. */
const LOOK_EVERY = Duration.hours(1);

/**
 * Forgets, for as long as the scope lasts, the apps nobody gave a grant and the codes and
 * tokens that ran out: anyone registers an app, so what is kept of them would only grow.
 */
export const makeForgetting = Effect.fn("Forgetting.make")(function* () {
  const grants = yield* Grants;

  yield* grants.forget().pipe(
    Effect.catchCause((cause) => Effect.logError("what apps left was not forgotten", cause)),
    Effect.repeat(Schedule.spaced(LOOK_EVERY)),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(makeForgetting());
