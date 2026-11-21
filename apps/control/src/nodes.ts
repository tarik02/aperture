import { type ExecutorClient, make, proto } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeepaliveInvalid, RegistrationRefused } from "./errors.ts";
import * as Secrets from "./secrets.ts";
import { keepaliveEvery, Settings } from "./settings.ts";
import { type Node, NodesStore, type Offers, type RegistrationToken } from "./store/nodes.ts";
import { ago, now } from "./time.ts";

/** What a node says of itself in a keepalive. */
export interface Keepalive {
  readonly registrationToken: string;
  readonly name: string;
  readonly internalUrl: string;
  readonly balancerUrl?: string | undefined;
  readonly publicUrl?: string | undefined;
  readonly operatorToken: string;
}

const bytes = (value: bigint | undefined) => (value === undefined ? undefined : Number(value));

/** `FEATURE_SOUND` is `SOUND` to the generated code and `sound` to the glossary. */
const word = (name: string | undefined) => (name ?? "unspecified").toLowerCase();

/** What an executor says of itself, as the control plane keeps it. */
export const offersOf = (executor: proto.Executor): Offers => ({
  version: executor.version,
  features: executor.features.map((feature) => word(proto.Feature[feature])),
  network: {
    tcp: word(proto.NetworkTcp[executor.network?.tcp ?? proto.NetworkTcp.UNSPECIFIED]),
    udp: word(proto.NetworkUdp[executor.network?.udp ?? proto.NetworkUdp.UNSPECIFIED]),
  },
  limits: {
    memoryBytes: bytes(executor.limits?.memoryBytes),
    swapBytes: bytes(executor.limits?.swapBytes),
    cpus: executor.limits?.cpus,
    tasks: bytes(executor.limits?.tasks),
    suspendIdleAfterSeconds: bytes(executor.limits?.suspendIdleAfter?.seconds),
  },
  holdsResources: executor.holdsResources,
});

const address = (what: string, given: string) => {
  const url = URL.canParse(given) ? new URL(given) : undefined;
  return url !== undefined && (url.protocol === "http:" || url.protocol === "https:")
    ? Effect.succeed(given.replace(/\/+$/u, ""))
    : Effect.fail(new KeepaliveInvalid({ message: `${what} is no http address: ${given}` }));
};

const optionalAddress = (what: string, given: string | undefined) =>
  given === undefined || given === "" ? Effect.succeed(null) : address(what, given);

export class Nodes extends Context.Service<
  Nodes,
  {
    /** A new registration token. The secret is told here and kept nowhere. */
    readonly createRegistrationToken: (
      name: string,
    ) => Effect.Effect<{ readonly token: RegistrationToken; readonly secret: string }>;
    readonly registrationTokens: Effect.Effect<ReadonlyArray<RegistrationToken>>;
    /**
     * Takes a node's keepalive: registers the node where its name is new, and keeps it in
     * use. Says how long the node is to wait before the next.
     */
    readonly keepalive: (
      said: Keepalive,
    ) => Effect.Effect<
      { readonly node: Node; readonly againAfter: Duration.Duration },
      RegistrationRefused | KeepaliveInvalid
    >;
    /** Every node that ever registered, and whether it is alive: not silent for too long. */
    readonly list: Effect.Effect<ReadonlyArray<{ readonly node: Node; readonly alive: boolean }>>;
    readonly alive: Effect.Effect<ReadonlyArray<Node>>;
    /** The nodes a new session may go to, the one to try first at the head. */
    readonly candidates: Effect.Effect<ReadonlyArray<Node>>;
    readonly find: (id: string) => Effect.Effect<Option.Option<Node>>;
    /** Keeps what a node's executor said of itself. */
    readonly describe: (node: Node, executor: proto.Executor) => Effect.Effect<void>;
    /** The node's executor, driven as its operator. */
    readonly executor: (node: Node) => ExecutorClient;
  }
>()("@aperture-browser/control/Nodes") {
  static readonly layer = Layer.effect(
    Nodes,
    Effect.gen(function* () {
      const store = yield* NodesStore;
      const settings = yield* Settings;
      const crypto = yield* Effect.context<Crypto.Crypto>();
      const silent = ago(settings.nodeSilentAfter);

      return Nodes.of({
        createRegistrationToken: Effect.fn("Nodes.createRegistrationToken")(function* (name) {
          const secret = yield* Secrets.make("apr");
          const token = yield* store.insertRegistrationToken({
            id: yield* Secrets.id,
            name,
            tokenHash: yield* Secrets.hash(secret),
            createdAt: yield* now,
          });
          return { token, secret };
        }, Effect.provide(crypto)),
        registrationTokens: store.listRegistrationTokens,
        keepalive: Effect.fn("Nodes.keepalive")(function* (said) {
          const token = yield* store.findRegistrationTokenByHash(
            yield* Secrets.hash(said.registrationToken),
          );
          if (Option.isNone(token)) {
            return yield* new RegistrationRefused({ message: "that is no registration token" });
          }
          if (said.name.trim() === "") {
            return yield* new KeepaliveInvalid({ message: "the node has no name" });
          }
          if (said.operatorToken === "") {
            return yield* new KeepaliveInvalid({ message: "the node gave no operator token" });
          }
          const node = yield* store.seen({
            id: yield* Secrets.id,
            name: said.name.trim(),
            internalUrl: yield* address("the internal address", said.internalUrl),
            balancerUrl: yield* optionalAddress("the load balancer's address", said.balancerUrl),
            publicUrl: yield* optionalAddress("the public address", said.publicUrl),
            operatorToken: said.operatorToken,
            registrationTokenId: token.value.id,
            now: yield* now,
          });
          return { node, againAfter: keepaliveEvery(settings) };
        }, Effect.provide(crypto)),
        list: Effect.gen(function* () {
          const since = yield* silent;
          const nodes = yield* store.list;
          return nodes.map((node) => ({
            node,
            alive: node.lastSeenAt.epochMilliseconds > since.getTime(),
          }));
        }),
        alive: Effect.flatMap(silent, store.seenSince),
        candidates: Effect.flatMap(silent, store.candidates),
        find: store.find,
        describe: (node, executor) => store.describe(node.id, offersOf(executor)),
        executor: (node) => make({ url: node.internalUrl, token: node.operatorToken }),
      });
    }),
  );
}
