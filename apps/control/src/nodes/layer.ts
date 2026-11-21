import { make, proto } from "@aperture-browser/executor-client";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeepaliveInvalid, RegistrationRefused } from "../errors.ts";
import * as Secrets from "../secrets.ts";
import { keepaliveEvery, Settings } from "../settings/service.ts";
import { ago, now } from "../time.ts";
import type { Keepalive, Node, Offers } from "./schemas.ts";
import { Nodes } from "./service.ts";
import { NodesStore } from "./store.ts";

const count = (value: bigint | undefined) => (value === undefined ? undefined : Number(value));

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
    memoryBytes: count(executor.limits?.memoryBytes),
    swapBytes: count(executor.limits?.swapBytes),
    cpus: executor.limits?.cpus,
    tasks: count(executor.limits?.tasks),
    suspendIdleAfterSeconds: count(executor.limits?.suspendIdleAfter?.seconds),
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

export const makeNodes = Effect.fn("Nodes.make")(function* () {
  const store = yield* NodesStore;
  const settings = yield* Settings;
  const crypto = yield* Effect.context<Crypto.Crypto>();
  const silent = ago(settings.nodeSilentAfter);

  const createRegistrationToken = Effect.fn("Nodes.createRegistrationToken")(function* (
    name: string,
  ) {
    const secret = yield* Secrets.make("apr");
    const token = yield* store.insertRegistrationToken({
      id: yield* Secrets.id,
      name,
      tokenHash: yield* Secrets.hash(secret),
      createdAt: yield* now,
    });
    return { token, secret };
  }, Effect.provide(crypto));

  const registrationTokens = Effect.fn("Nodes.registrationTokens")(function* () {
    return yield* store.listRegistrationTokens();
  });

  const keepalive = Effect.fn("Nodes.keepalive")(function* (said: Keepalive) {
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
  }, Effect.provide(crypto));

  const list = Effect.fn("Nodes.list")(function* () {
    const since = yield* silent;
    const nodes = yield* store.list();
    return nodes.map((node) => ({
      node,
      alive: DateTime.toEpochMillis(node.lastSeenAt) > since.getTime(),
    }));
  });

  const alive = Effect.fn("Nodes.alive")(function* () {
    return yield* store.seenSince(yield* silent);
  });

  const candidates = Effect.fn("Nodes.candidates")(function* () {
    return yield* store.candidates(yield* silent);
  });

  const find = Effect.fn("Nodes.find")(function* (id: string) {
    return yield* store.find(id);
  });

  const describe = Effect.fn("Nodes.describe")(function* (node: Node, executor: proto.Executor) {
    yield* store.describe(node.id, offersOf(executor));
  });

  const executor = (node: Node) => make({ url: node.internalUrl, token: node.operatorToken });

  return Nodes.of({
    createRegistrationToken,
    registrationTokens,
    keepalive,
    list,
    alive,
    candidates,
    find,
    describe,
    executor,
  });
});

export const layer = Layer.effect(Nodes, makeNodes());
