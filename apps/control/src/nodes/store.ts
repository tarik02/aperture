import type { Offers } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { NodeRecord, RegistrationToken } from "./schemas.ts";

export interface NewRegistrationToken {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
}

/** What a node said of itself, and when. `id` is for a node whose name is new. */
export interface SeenNode {
  readonly id: string;
  readonly name: string;
  readonly internalUrl: string;
  readonly balancerUrl: string | null;
  readonly publicUrl: string | null;
  readonly operatorTokenSealed: string;
  /** The token it registered with; none for the one that is good without being made. */
  readonly registrationTokenId: string | null;
  readonly now: Date;
}

/** Where nodes and the tokens that let them register are kept. */
export interface NodesStoreShape {
  readonly insertRegistrationToken: (
    token: NewRegistrationToken,
  ) => Effect.Effect<RegistrationToken>;
  readonly listRegistrationTokens: () => Effect.Effect<ReadonlyArray<RegistrationToken>>;
  readonly findRegistrationTokenByHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<RegistrationToken>>;
  /**
   * Writes what a node said of itself and that it was seen now. The node with that name
   * stays the node it was.
   */
  readonly seen: (node: SeenNode) => Effect.Effect<NodeRecord>;
  readonly describe: (id: string, offers: Offers) => Effect.Effect<void>;
  /**
   * Notes that the nodes not seen since then fell silent, and gives those it was not
   * noted of before: each is given once, until it is seen again.
   */
  readonly noteSilent: (since: Date, now: Date) => Effect.Effect<ReadonlyArray<NodeRecord>>;
  readonly list: () => Effect.Effect<ReadonlyArray<NodeRecord>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<NodeRecord>>;
  /** The nodes seen since then. */
  readonly seenSince: (since: Date) => Effect.Effect<ReadonlyArray<NodeRecord>>;
  /**
   * The nodes a new session may go to: seen since then and reached at least once, the
   * one with the fewest sessions first.
   */
  readonly candidates: (since: Date) => Effect.Effect<ReadonlyArray<NodeRecord>>;
}

export class NodesStore extends Context.Service<NodesStore, NodesStoreShape>()(
  "@aperture-browser/control/NodesStore",
) {}
