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

/** What a node said of itself, and when. */
export interface SeenNode {
  readonly name: string;
  readonly internalUrl: string;
  readonly balancerUrl: string | null;
  readonly publicUrl: string | null;
  /** The token it registered with; none for the one that is good without being made. */
  readonly registrationTokenId: string | null;
  readonly now: Date;
}

/** What is kept in place of a node's operator token once an admin let its name go. */
export const RELEASED = "";

/** Where nodes and the tokens that let them register are kept. */
export interface NodesStoreShape {
  readonly insertRegistrationToken: (
    token: NewRegistrationToken,
  ) => Effect.Effect<RegistrationToken>;
  readonly listRegistrationTokens: () => Effect.Effect<ReadonlyArray<RegistrationToken>>;
  readonly findRegistrationToken: (id: string) => Effect.Effect<Option.Option<RegistrationToken>>;
  /** The token with that digest, one that was taken back as well: it says that it was. */
  readonly findRegistrationTokenByHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<RegistrationToken>>;
  /** Takes a token back; one that was taken back before stays as it was. */
  readonly revokeRegistrationToken: (id: string, now: Date) => Effect.Effect<void>;
  /** Keeps a node under a name that is new; none where the name is taken by now. */
  readonly register: (
    node: SeenNode & { readonly id: string; readonly operatorTokenSealed: string },
  ) => Effect.Effect<Option.Option<NodeRecord>>;
  /**
   * Writes what a node said of itself and that it was seen now, with its operator token
   * where one is given. The node stays the node it was. None where its operator token is
   * no longer kept as `held`: another registered under the name meanwhile.
   */
  readonly seen: (
    id: string,
    held: string,
    node: SeenNode & { readonly operatorTokenSealed: string | null },
  ) => Effect.Effect<Option.Option<NodeRecord>>;
  /** Forgets a node's operator token, so that the next to register under its name is the node. */
  readonly release: (id: string) => Effect.Effect<Option.Option<NodeRecord>>;
  readonly describe: (id: string, offers: Offers) => Effect.Effect<void>;
  /**
   * Notes that the nodes not seen since then fell silent, and gives those it was not
   * noted of before: each is given once, until it is seen again.
   */
  readonly noteSilent: (since: Date, now: Date) => Effect.Effect<ReadonlyArray<NodeRecord>>;
  readonly list: () => Effect.Effect<ReadonlyArray<NodeRecord>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<NodeRecord>>;
  readonly findByName: (name: string) => Effect.Effect<Option.Option<NodeRecord>>;
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
