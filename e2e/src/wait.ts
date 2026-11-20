import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const EVERY = Duration.millis(100);

/** A check that did not come true in time. */
export class TimedOut extends Schema.TaggedError<TimedOut>()("TimedOut", {
  what: Schema.String,
  within: Schema.String,
}) {
  override get message() {
    return `${this.what} did not happen within ${this.within}`;
  }
}

class NothingYet extends Schema.TaggedError<NothingYet>()("NothingYet", {}) {}

/**
 * Looks until there is something to see: what `look` gives once it is neither undefined,
 * null nor false. A look that fails is a look that saw nothing yet.
 */
export const until = <A, E, R>(
  what: string,
  look: Effect.Effect<A | undefined | null | false, E, R>,
  within: Duration.Input = "15 seconds",
): Effect.Effect<A, TimedOut, R> =>
  look.pipe(
    // A look that dies saw nothing either: what is asked may not be there to answer yet.
    Effect.catchCause(() => Effect.succeed(undefined)),
    Effect.flatMap((seen) =>
      seen !== undefined && seen !== null && seen !== false
        ? Effect.succeed(seen)
        : Effect.fail(new NothingYet()),
    ),
    Effect.retry(Schedule.spaced(EVERY).pipe(Schedule.upTo({ duration: within }))),
    Effect.mapError(
      () => new TimedOut({ what, within: Duration.format(Duration.fromInputUnsafe(within)) }),
    ),
  );

/** Whether it comes true in time, for a check that says so itself. */
export const happens = <A, E, R>(
  look: Effect.Effect<A | undefined | null | false, E, R>,
  within?: Duration.Input,
): Effect.Effect<boolean, never, R> =>
  until("it", look, within).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
