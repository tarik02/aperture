import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The digests of Aperture v1's API tokens that `aperture-migrate` brought along, until each
 * token is first used: then it is found by its digest in `api_tokens` as any other, and its
 * row here is removed for good, as nothing is lost with it. The table goes with the code
 * that reads it, once nothing is left in it; see `src/v1-credentials/`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE v1_api_tokens (
      token_id uuid PRIMARY KEY REFERENCES api_tokens (id),
      -- bcrypt, as v1 kept it, of what follows the token's id.
      digest text NOT NULL
    )
  `;
});
