import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { StoredProvider } from "./schemas.ts";
import { type ChangedProvider, type NewProvider, ProvidersStore } from "./store.ts";

/** A count comes as text: it is wider than a number is sure to hold, and never gets there. */
const Revision = Schema.Struct({ revision: Schema.NumberFromString });

/** Providers in the SQL database. */
export const makeProvidersStore = Effect.fn("ProvidersStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // In the statement that changes a provider, so that the two are done together or not at all.
  const counted = sql.literal(
    "counted AS (UPDATE providers_revision SET revision = revision + 1 RETURNING revision)",
  );

  const insert = Effect.fn("ProvidersStore.insert")(function* (given: NewProvider) {
    return yield* sql`
      WITH ${counted}
      INSERT INTO providers (
        id, name, issuer, client_id, client_secret_sealed, scopes, provision, domains, enabled,
        created_at, updated_at
      )
      VALUES (
        ${given.id}, ${given.name}, ${given.issuer}, ${given.clientId},
        ${given.clientSecretSealed}, ${JSON.stringify(given.scopes)}::jsonb, ${given.provision},
        ${JSON.stringify(given.domains)}::jsonb, ${given.enabled}, ${given.createdAt},
        ${given.createdAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `.pipe(first(StoredProvider));
  });

  const list = Effect.fn("ProvidersStore.list")(function* () {
    return yield* sql`SELECT * FROM providers ORDER BY created_at, id`.pipe(all(StoredProvider));
  });

  const find = Effect.fn("ProvidersStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM providers WHERE id = ${id}`.pipe(first(StoredProvider));
  });

  const update = Effect.fn("ProvidersStore.update")(function* (id: string, to: ChangedProvider) {
    return yield* sql`
      WITH ${counted}
      UPDATE providers SET
        name = ${to.name}, issuer = ${to.issuer}, client_id = ${to.clientId},
        client_secret_sealed = ${to.clientSecretSealed},
        scopes = ${JSON.stringify(to.scopes)}::jsonb, provision = ${to.provision},
        domains = ${JSON.stringify(to.domains)}::jsonb, enabled = ${to.enabled},
        updated_at = ${to.updatedAt}
      WHERE id = ${id}
      RETURNING *
    `.pipe(first(StoredProvider));
  });

  const delete_ = Effect.fn("ProvidersStore.delete")(function* (id: string) {
    yield* sql`WITH ${counted} DELETE FROM providers WHERE id = ${id}`.pipe(done);
  });

  const revision = Effect.fn("ProvidersStore.revision")(function* () {
    const counted = yield* sql`SELECT revision::text FROM providers_revision`.pipe(one(Revision));
    return counted.revision;
  });

  return ProvidersStore.of({ insert, list, find, update, delete: delete_, revision });
});

export const layer = Layer.effect(ProvidersStore, makeProvidersStore());
