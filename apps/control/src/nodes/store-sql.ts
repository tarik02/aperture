import { Offers } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { NodeRecord, RegistrationToken } from "./schemas.ts";
import { type NewRegistrationToken, NodesStore, type NodesStoreShape, RELEASED } from "./store.ts";

const encodeOffers = Schema.encodeSync(Schema.fromJsonString(Offers));

/** Nodes in the SQL database. */
export const makeNodesStore = Effect.fn("NodesStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Never the digest: a token is known by it, and it is told to nobody.
  const kept = sql.literal("id, name, created_at, revoked_at");

  const insertRegistrationToken = Effect.fn("NodesStore.insertRegistrationToken")(function* (
    token: NewRegistrationToken,
  ) {
    return yield* sql`
      INSERT INTO registration_tokens (id, name, token_hash, created_at)
      VALUES (${token.id}, ${token.name}, ${token.tokenHash}, ${token.createdAt})
      RETURNING ${kept}
    `.pipe(one(RegistrationToken));
  });

  const listRegistrationTokens = Effect.fn("NodesStore.listRegistrationTokens")(function* () {
    return yield* sql`
      SELECT ${kept} FROM registration_tokens ORDER BY created_at, id
    `.pipe(all(RegistrationToken));
  });

  const findRegistrationToken = Effect.fn("NodesStore.findRegistrationToken")(function* (
    id: string,
  ) {
    return yield* sql`SELECT ${kept} FROM registration_tokens WHERE id = ${id}`.pipe(
      first(RegistrationToken),
    );
  });

  const findRegistrationTokenByHash = Effect.fn("NodesStore.findRegistrationTokenByHash")(
    function* (tokenHash: string) {
      return yield* sql`
        SELECT ${kept} FROM registration_tokens WHERE token_hash = ${tokenHash}
      `.pipe(first(RegistrationToken));
    },
  );

  const revokeRegistrationToken = Effect.fn("NodesStore.revokeRegistrationToken")(function* (
    id: string,
    now: Date,
  ) {
    yield* sql`
      UPDATE registration_tokens SET revoked_at = ${now} WHERE id = ${id} AND revoked_at IS NULL
    `.pipe(done);
  });

  const register = Effect.fn("NodesStore.register")(function* (
    node: Parameters<NodesStoreShape["register"]>[0],
  ) {
    return yield* sql`
      INSERT INTO nodes (
        id, name, internal_url, balancer_url, public_url, operator_token_sealed,
        registration_token_id, registered_at, last_seen_at
      )
      VALUES (
        ${node.id}, ${node.name}, ${node.internalUrl}, ${node.balancerUrl},
        ${node.publicUrl}, ${node.operatorTokenSealed}, ${node.registrationTokenId},
        ${node.now}, ${node.now}
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING *
    `.pipe(first(NodeRecord));
  });

  const seen = Effect.fn("NodesStore.seen")(function* (
    id: string,
    held: string,
    node: Parameters<NodesStoreShape["seen"]>[2],
  ) {
    return yield* sql`
      UPDATE nodes SET
        internal_url = ${node.internalUrl},
        balancer_url = ${node.balancerUrl},
        public_url = ${node.publicUrl},
        operator_token_sealed = ${node.operatorTokenSealed ?? held},
        registration_token_id = ${node.registrationTokenId},
        last_seen_at = ${node.now},
        silent_at = NULL
      WHERE id = ${id} AND operator_token_sealed = ${held}
      RETURNING *
    `.pipe(first(NodeRecord));
  });

  const release = Effect.fn("NodesStore.release")(function* (id: string) {
    return yield* sql`
      UPDATE nodes SET operator_token_sealed = ${RELEASED} WHERE id = ${id} RETURNING *
    `.pipe(first(NodeRecord));
  });

  const describe = Effect.fn("NodesStore.describe")(function* (id: string, offers: Offers) {
    yield* sql`UPDATE nodes SET offers = ${encodeOffers(offers)}::jsonb WHERE id = ${id}`.pipe(
      done,
    );
  });

  const noteSilent = Effect.fn("NodesStore.noteSilent")(function* (since: Date, now: Date) {
    return yield* sql`
      UPDATE nodes SET silent_at = ${now}
      WHERE last_seen_at <= ${since} AND silent_at IS NULL
      RETURNING *
    `.pipe(all(NodeRecord));
  });

  const list = Effect.fn("NodesStore.list")(function* () {
    return yield* sql`SELECT * FROM nodes ORDER BY registered_at, id`.pipe(all(NodeRecord));
  });

  const find = Effect.fn("NodesStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM nodes WHERE id = ${id}`.pipe(first(NodeRecord));
  });

  const findByName = Effect.fn("NodesStore.findByName")(function* (name: string) {
    return yield* sql`SELECT * FROM nodes WHERE name = ${name}`.pipe(first(NodeRecord));
  });

  const seenSince = Effect.fn("NodesStore.seenSince")(function* (since: Date) {
    return yield* sql`
      SELECT * FROM nodes WHERE last_seen_at > ${since} ORDER BY registered_at, id
    `.pipe(all(NodeRecord));
  });

  const candidates = Effect.fn("NodesStore.candidates")(function* (since: Date) {
    return yield* sql`
      SELECT nodes.*
      FROM nodes
      LEFT JOIN sessions ON sessions.node_id = nodes.id
      WHERE nodes.last_seen_at > ${since} AND nodes.offers IS NOT NULL
      GROUP BY nodes.id
      ORDER BY count(sessions.id), nodes.registered_at, nodes.id
    `.pipe(all(NodeRecord));
  });

  return NodesStore.of({
    insertRegistrationToken,
    listRegistrationTokens,
    findRegistrationToken,
    findRegistrationTokenByHash,
    revokeRegistrationToken,
    register,
    seen,
    release,
    describe,
    noteSilent,
    list,
    find,
    findByName,
    seenSince,
    candidates,
  });
});

export const layer = Layer.effect(NodesStore, makeNodesStore());
