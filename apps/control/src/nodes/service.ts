import type { NodeNotFound } from "@aperture-browser/control-api";
import type { ExecutorClient, proto } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type {
  KeepaliveInvalid,
  RegistrationRefused,
  RegistrationTokenNotFound,
} from "../errors.ts";
import type { Keepalive, Node, NodeRecord, RegistrationToken } from "./schemas.ts";

/** The nodes that registered, which of them are in use, and how each is reached. */
export interface NodesShape {
  /** A new registration token. The secret is told here and kept nowhere. */
  readonly createRegistrationToken: (
    name: string,
  ) => Effect.Effect<{ readonly token: RegistrationToken; readonly secret: string }>;
  /** Every registration token that was made, those taken back among them. */
  readonly registrationTokens: () => Effect.Effect<ReadonlyArray<RegistrationToken>>;
  /**
   * Takes a registration token back: no new node registers with it, and no node says
   * anything new of itself with it. The nodes that registered with it stay.
   */
  readonly revokeRegistrationToken: (id: string) => Effect.Effect<void, RegistrationTokenNotFound>;
  /**
   * Takes a node's keepalive: registers the node where its name is new, and keeps it in
   * use. A name that is taken is its node's alone: a keepalive under it is taken only with
   * the operator token the node registered with. Says how long the node is to wait before the next. With a token that was taken
   * back it is taken of a node that registered with that token alone, and only while the
   * node says of itself what it said before.
   */
  readonly keepalive: (
    said: Keepalive,
  ) => Effect.Effect<
    { readonly node: Node; readonly againAfter: Duration.Duration },
    RegistrationRefused | KeepaliveInvalid
  >;
  /**
   * Lets a node's name go: its operator token is forgotten, and the next node to register
   * under the name is the node, with the sessions it had. For a node that was installed
   * again and no longer has the token it registered with.
   */
  readonly release: (id: string) => Effect.Effect<void, NodeNotFound>;
  /** Every node that ever registered, and whether it is alive: not silent for too long. */
  readonly list: () => Effect.Effect<
    ReadonlyArray<{ readonly node: NodeRecord; readonly alive: boolean }>
  >;
  /**
   * The nodes that are alive, those the control plane can drive: one whose operator
   * token does not open, as after the master key changed, is left out until its next
   * keepalive gives the token again.
   */
  readonly alive: () => Effect.Effect<ReadonlyArray<Node>>;
  /** The nodes a new session may go to, the one to try first at the head. */
  readonly candidates: () => Effect.Effect<ReadonlyArray<Node>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Node>>;
  /** Keeps what a node's executor said of itself. */
  readonly describe: (node: Node, executor: proto.Executor) => Effect.Effect<void>;
  /** Notes which nodes fell silent since it was last looked: each once, until it is back. */
  readonly noteSilent: () => Effect.Effect<void>;
  /** The node's executor, driven as its operator. */
  readonly executor: (node: Node) => ExecutorClient;
}

export class Nodes extends Context.Service<Nodes, NodesShape>()(
  "@aperture-browser/control/Nodes",
) {}
