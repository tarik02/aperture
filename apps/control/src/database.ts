import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Str from "effect/String";
import { migrate } from "./migrations/index.ts";
import { Settings } from "./settings/service.ts";

export { migrate };
export { SOFT_DELETED } from "./migrations/0001_initial.ts";

const client = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings;
    return PgClient.layer({
      url: settings.databaseUrl,
      applicationName: "aperture-control",
      transformResultNames: Str.snakeToCamel,
    });
  }),
);

/** The database, migrated before anything is asked of it. */
export const layer = Layer.effectDiscard(migrate).pipe(Layer.provideMerge(client));
