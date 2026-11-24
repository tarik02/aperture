import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A session's node says one more thing of it: that it is being restored, which is its
 * browser being given the storage state the session was created with.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`ALTER TABLE sessions DROP CONSTRAINT sessions_observed_state_check`);
  yield* sql.unsafe(
    `ALTER TABLE sessions ADD CONSTRAINT sessions_observed_state_check CHECK (
      observed_state IN (
        'suspended', 'starting', 'restoring', 'running', 'suspending', 'failed', 'gone'
      )
    )`,
  );
});
