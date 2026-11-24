import * as PgClient from "@effect/sql-pg/PgClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as App from "../../src/app.ts";
import * as Settings from "../../src/settings/layer.ts";
import * as Postgres from "./postgres.ts";

/**
 * The control plane's stores on a database of the suite's own, with the settings they were
 * made by and the database itself: for checks of a service that is asked by no HTTP.
 */
export const layer = (settings: Readonly<Record<string, string>> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const postgres = yield* Postgres.Postgres;
      return Layer.merge(
        App.stores.pipe(
          Layer.provideMerge(Settings.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({
                APERTURE_CONTROL_DATABASE_URL: postgres.url,
                APERTURE_CONTROL_BOOTSTRAP_TOKEN: "a token",
                APERTURE_CONTROL_MASTER_KEY: "/nowhere",
                APERTURE_CONTROL_TICKET_KEY: "/nowhere",
                ...settings,
              }),
            ),
          ),
        ),
        PgClient.layer({ url: Redacted.make(postgres.url) }),
      );
    }),
  ).pipe(Layer.provide(Postgres.layer));

/** Word of every time what is forgotten once in a while was looked for. */
export class Swept extends Context.Service<Swept, Queue.Queue<void>>()(
  "@aperture-browser/control/tests/Swept",
) {}

/**
 * What forgets once in a while, on the clock of the check it is given to, which moves that
 * clock itself. The database answers in its own time, and not in the clock's: the service
 * tells each time it has looked, and the check waits for that before it sees what is left.
 */
export const forgetting = <I, S extends { readonly forget: () => Effect.Effect<void> }, E, R>(
  service: Context.Service<I, S>,
  looking: Layer.Layer<never, E, I | R>,
) =>
  Layer.effectDiscard(Swept.use(Queue.take)).pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const asked = yield* service;
          const swept = yield* Queue.unbounded<void>();
          const telling: S = {
            ...asked,
            forget: () => Effect.ensuring(asked.forget(), Queue.offer(swept, undefined)),
          };
          return Layer.merge(
            Layer.succeed(Swept, swept),
            Layer.provide(looking, Layer.succeed(service, telling)),
          );
        }),
      ),
    ),
    Layer.provideMerge(TestClock.layer()),
  );

/** Lets so many hours go by, and what is looked for every hour be looked for in each. */
export const hours = (count: number) =>
  Effect.gen(function* () {
    const swept = yield* Swept;
    for (let hour = 0; hour < count; hour += 1) {
      yield* TestClock.adjust("1 hour");
      yield* Queue.take(swept);
    }
  });
