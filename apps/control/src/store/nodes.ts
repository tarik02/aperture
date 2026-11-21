import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { all, done, first, one } from "./rows.ts";

/** What a node's executor says its sessions may have, in the words of the glossary. */
export const Offers = Schema.Struct({
  version: Schema.String,
  features: Schema.Array(Schema.String),
  network: Schema.Struct({ tcp: Schema.String, udp: Schema.String }),
  /** The limits of a session that has none of its own; one that is left out is not held. */
  limits: Schema.Struct({
    memoryBytes: Schema.optional(Schema.Number),
    swapBytes: Schema.optional(Schema.Number),
    cpus: Schema.optional(Schema.Number),
    tasks: Schema.optional(Schema.Number),
    suspendIdleAfterSeconds: Schema.optional(Schema.Number),
  }),
  holdsResources: Schema.Boolean,
});
export type Offers = typeof Offers.Type;

export const Node = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  internalUrl: Schema.String,
  balancerUrl: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  operatorToken: Schema.String,
  /** None until the control plane has reached the node's executor. */
  offers: Schema.NullOr(Offers),
  registeredAt: Schema.DateTimeUtcFromDate,
  lastSeenAt: Schema.DateTimeUtcFromDate,
});
export type Node = typeof Node.Type;

/** A registration token as it is kept: never the token. */
export const RegistrationToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromDate,
});
export type RegistrationToken = typeof RegistrationToken.Type;

const encodeOffers = Schema.encodeSync(Schema.fromJsonString(Offers));

export class NodesStore extends Context.Service<
  NodesStore,
  {
    readonly insertRegistrationToken: (token: {
      readonly id: string;
      readonly name: string;
      readonly tokenHash: string;
      readonly createdAt: Date;
    }) => Effect.Effect<RegistrationToken>;
    readonly listRegistrationTokens: Effect.Effect<ReadonlyArray<RegistrationToken>>;
    readonly findRegistrationTokenByHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<RegistrationToken>>;
    /**
     * Writes what a node said of itself and that it was seen now. The node with that name
     * stays the node it was; `id` is for one that is new.
     */
    readonly seen: (node: {
      readonly id: string;
      readonly name: string;
      readonly internalUrl: string;
      readonly balancerUrl: string | null;
      readonly publicUrl: string | null;
      readonly operatorToken: string;
      readonly registrationTokenId: string;
      readonly now: Date;
    }) => Effect.Effect<Node>;
    readonly describe: (id: string, offers: Offers) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<Node>>;
    readonly find: (id: string) => Effect.Effect<Option.Option<Node>>;
    /** The nodes seen since then. */
    readonly seenSince: (since: Date) => Effect.Effect<ReadonlyArray<Node>>;
    /**
     * The nodes a new session may go to: seen since then and reached at least once, the
     * one with the fewest sessions first.
     */
    readonly candidates: (since: Date) => Effect.Effect<ReadonlyArray<Node>>;
  }
>()("@aperture-browser/control/NodesStore") {
  static readonly layer = Layer.effect(
    NodesStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return NodesStore.of({
        insertRegistrationToken: (token) =>
          sql`
            INSERT INTO registration_tokens (id, name, token_hash, created_at)
            VALUES (${token.id}, ${token.name}, ${token.tokenHash}, ${token.createdAt})
            RETURNING id, name, created_at
          `.pipe(one(RegistrationToken)),
        listRegistrationTokens: sql`
          SELECT id, name, created_at FROM registration_tokens ORDER BY created_at, id
        `.pipe(all(RegistrationToken)),
        findRegistrationTokenByHash: (tokenHash) =>
          sql`
            SELECT id, name, created_at FROM registration_tokens WHERE token_hash = ${tokenHash}
          `.pipe(first(RegistrationToken)),
        seen: (node) =>
          sql`
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
          `.pipe(one(Node)),
        describe: (id, offers) =>
          sql`UPDATE nodes SET offers = ${encodeOffers(offers)}::jsonb WHERE id = ${id}`.pipe(done),
        list: sql`SELECT * FROM nodes ORDER BY registered_at, id`.pipe(all(Node)),
        find: (id) => sql`SELECT * FROM nodes WHERE id = ${id}`.pipe(first(Node)),
        seenSince: (since) =>
          sql`
            SELECT * FROM nodes WHERE last_seen_at > ${since} ORDER BY registered_at, id
          `.pipe(all(Node)),
        candidates: (since) =>
          sql`
            SELECT nodes.*
            FROM nodes
            LEFT JOIN sessions ON sessions.node_id = nodes.id
            WHERE nodes.last_seen_at > ${since} AND nodes.offers IS NOT NULL
            GROUP BY nodes.id
            ORDER BY count(sessions.id), nodes.registered_at, nodes.id
          `.pipe(all(Node)),
      });
    }),
  );
}
