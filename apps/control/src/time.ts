import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** This moment, as the database takes it. */
export const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis)));

/** The moment that long before this one. */
export const ago = (duration: Duration.Duration) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((millis) => new Date(millis - Duration.toMillis(duration))),
  );

/** The moment that long after this one. */
export const after = (duration: Duration.Duration) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((millis) => new Date(millis + Duration.toMillis(duration))),
  );
