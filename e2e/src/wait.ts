import * as Effect from "effect/Effect";

const EVERY_MS = 100;

/** A check that did not come true in time. */
export class TimedOut extends Error {
  constructor(what: string, within: number) {
    super(`${what} did not happen within ${within / 1000} s`);
    this.name = "TimedOut";
  }
}

/**
 * Looks until there is something to see: what `look` gives once it is neither undefined,
 * null nor false. A look that fails is a look that saw nothing yet.
 */
export const until = <A, E, R>(
  what: string,
  look: Effect.Effect<A | undefined | null | false, E, R>,
  withinMs = 15_000,
): Effect.Effect<A, TimedOut, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + withinMs;
    for (;;) {
      // A look that dies saw nothing either: what is asked may not be there to answer yet.
      const seen = yield* look.pipe(Effect.catchCause(() => Effect.succeed(undefined)));
      if (seen !== undefined && seen !== null && seen !== false) {
        return seen;
      }
      if (Date.now() >= deadline) {
        return yield* Effect.fail(new TimedOut(what, withinMs));
      }
      yield* Effect.sleep(EVERY_MS);
    }
  });

/** Whether it comes true in time, for a check that says so itself. */
export const happens = <A, E, R>(
  look: Effect.Effect<A | undefined | null | false, E, R>,
  withinMs = 15_000,
): Effect.Effect<boolean, never, R> =>
  until("it", look, withinMs).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
