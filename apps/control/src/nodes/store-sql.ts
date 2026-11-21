import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "../store/rows.ts";
import { Node, Offers, RegistrationToken } from "./schemas.ts";
import { type NewRegistrationToken, NodesStore, type SeenNode } from "./store.ts";

const encodeOffers = Schema.encodeSync(Schema.fromJsonString(Offers));

/** Nodes in the SQL database. */
export const makeNodesStore = Effect.fn("NodesStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRegistrationToken = Effect.fn("NodesStore.insertRegistrationToken")(function* (
    token: NewRegistrationToken,
  ) {
    return yield* sql`
      INSERT INTO registration_tokens (id, name, token_hash, created_at)
      VALUES (${token.id}, ${token.name}, ${token.tokenHash}, ${token.createdAt})
      RETURNING id, name, created_at
    `.pipe(one(RegistrationToken));
  });

  const listRegistrationTokens = Effect.fn("NodesStore.listRegistrationTokens")(function* () {
    return yield* sql`
      SELECT id, name, created_at FROM registration_tokens ORDER BY created_at, id
    `.pipe(all(RegistrationToken));
  });

  const findRegistrationTokenByHash = Effect.fn("NodesStore.findRegistrationTokenByHash")(
    function* (tokenHash: string) {
      return yield* sql`
        SELECT id, name, created_at FROM registration_tokens WHERE token_hash = ${tokenHash}
      `.pipe(first(RegistrationToken));
    },
  );

  const seen = Effect.fn("NodesStore.seen")(function* (node: SeenNode) {
    return yield* sql`
      INSERT INTO nodes (
        id, name, internal_url, balancer_url, public_url, operator_token,
        registration_token_id, registered_at, last_seen_at
      )
      VALUES (
        ${node.id}, ${node.name}, ${node.internalUrl}, ${node.balancerUrl},
        ${node.publicUrl}, ${node.operatorToken}, ${node.registrationTokenId},
        ${node.now}, ${node.now}
      )
      ON CONFLICT (name) DO UPDATE SET
        internal_url = EXCLUDED.internal_url,
        balancer_url = EXCLUDED.balancer_url,
        public_url = EXCLUDED.public_url,
        operator_token = EXCLUDED.operator_token,
        registration_token_id = EXCLUDED.registration_token_id,
        last_seen_at = EXCLUDED.last_seen_at
      RETURNING *
    `.pipe(one(Node));
  });

  const describe = Effect.fn("NodesStore.describe")(function* (id: string, offers: Offers) {
    yield* sql`UPDATE nodes SET offers = ${encodeOffers(offers)}::jsonb WHERE id = ${id}`.pipe(
      done,
    );
  });

  const list = Effect.fn("NodesStore.list")(function* () {
    return yield* sql`SELECT * FROM nodes ORDER BY registered_at, id`.pipe(all(Node));
  });

  const find = Effect.fn("NodesStore.find")(function* (id: string) {
    return yield* sql`SELECT * FROM nodes WHERE id = ${id}`.pipe(first(Node));
  });

  const seenSince = Effect.fn("NodesStore.seenSince")(function* (since: Date) {
    return yield* sql`
      SELECT * FROM nodes WHERE last_seen_at > ${since} ORDER BY registered_at, id
    `.pipe(all(Node));
  });

  const candidates = Effect.fn("NodesStore.candidates")(function* (since: Date) {
    return yield* sql`
      SELECT nodes.*
      FROM nodes
      LEFT JOIN sessions ON sessions.node_id = nodes.id
      WHERE nodes.last_seen_at > ${since} AND nodes.offers IS NOT NULL
      GROUP BY nodes.id
      ORDER BY count(sessions.id), nodes.registered_at, nodes.id
    `.pipe(all(Node));
  });

  return NodesStore.of({
    insertRegistrationToken,
    listRegistrationTokens,
    findRegistrationTokenByHash,
    seen,
    describe,
    list,
    find,
    seenSince,
    candidates,
  });
});

export const layer = Layer.effect(NodesStore, makeNodesStore());
