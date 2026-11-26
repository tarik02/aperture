import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A share link may be made without saying whom it is for, and may let its guests see one
 * tab of its session, by the tab's number, which stays the tab's over a suspend and a
 * resume. The view a table is read through has the columns there were when it was made:
 * it is made again with the new one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_shares ALTER COLUMN name DROP NOT NULL`;
  yield* sql`ALTER TABLE session_shares ADD COLUMN tab integer CHECK (tab >= 0)`;
  yield* sql`
    CREATE OR REPLACE VIEW live_session_shares AS
    SELECT * FROM session_shares WHERE deleted_at IS NULL
  `;
});
