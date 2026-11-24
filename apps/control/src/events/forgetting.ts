import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Events } from "./service.ts";

/** How often events that were kept long enough are looked for. */
const LOOK_EVERY = Duration.hours(1);

/**
 * Forgets, for as long as the scope lasts, the events that are older than they are kept
 * for: what is written of everything that is done would only grow.
 */
export const makeEventsForgetting = Effect.fn("EventsForgetting.make")(function* () {
  const events = yield* Events;

  yield* events.forget().pipe(
    Effect.catchCause((cause) => Effect.logError("old events were not forgotten", cause)),
    Effect.repeat(Schedule.spaced(LOOK_EVERY)),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(makeEventsForgetting());
