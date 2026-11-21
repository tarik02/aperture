import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Share } from "./schemas.ts";
import { type NewShare, SharesStore } from "./store.ts";

/** Share links in the SQL database. */
export const makeSharesStore = Effect.fn("SharesStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Never the digest: a link is known by it, and it is told to nobody.
  const share = sql.literal(
    "id, session_id, account_id, name, role, created_at, expires_at, last_used_at",
  );

  const insert = Effect.fn("SharesStore.insert")(function* (given: NewShare) {
    return yield* sql`
      INSERT INTO session_shares (
        id, session_id, account_id, name, role, token_hash, created_at, expires_at
      )
      VALUES (
        ${given.id}, ${given.sessionId}, ${given.accountId}, ${given.name}, ${given.role},
        ${given.tokenHash}, ${given.createdAt}, ${given.expiresAt}
      )
      RETURNING ${share}
    `.pipe(one(Share));
  });

  const listOf = Effect.fn("SharesStore.listOf")(function* (sessionId: string) {
    return yield* sql`
      SELECT ${share} FROM session_shares WHERE session_id = ${sessionId}
      ORDER BY created_at, id
    `.pipe(all(Share));
  });

  const find = Effect.fn("SharesStore.find")(function* (id: string) {
    return yield* sql`SELECT ${share} FROM session_shares WHERE id::text = ${id}`.pipe(
      first(Share),
    );
  });

  const findByTokenHash = Effect.fn("SharesStore.findByTokenHash")(function* (
    tokenHash: string,
    now: Date,
  ) {
    return yield* sql`
      SELECT ${share} FROM session_shares
      WHERE token_hash = ${tokenHash} AND (expires_at IS NULL OR expires_at > ${now})
    `.pipe(first(Share));
  });

  const delete_ = Effect.fn("SharesStore.delete")(function* (id: string) {
    yield* sql`DELETE FROM session_shares WHERE id::text = ${id}`.pipe(done);
  });

  const used = Effect.fn("SharesStore.used")(function* (id: string, now: Date, since: Date) {
    yield* sql`
      UPDATE session_shares SET last_used_at = ${now}
      WHERE id::text = ${id} AND (last_used_at IS NULL OR last_used_at <= ${since})
    `.pipe(done);
  });

  return SharesStore.of({ insert, listOf, find, findByTokenHash, delete: delete_, used });
});

export const layer = Layer.effect(SharesStore, makeSharesStore());
