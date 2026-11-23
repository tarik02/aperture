import type { Offers } from "@aperture-browser/control-api";
import { make, proto } from "@aperture-browser/executor-client";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { NodeNotFound } from "@aperture-browser/control-api";
import { KeepaliveInvalid, RegistrationRefused, RegistrationTokenNotFound } from "../errors.ts";
import { Doer } from "../events/doer.ts";
import { Events } from "../events/service.ts";
import * as Secrets from "../secrets.ts";
import { keepaliveEvery, Settings } from "../settings/service.ts";
import { ago, now } from "../time.ts";
import { Vault } from "../vault/service.ts";
import { address } from "./address.ts";
import type { Keepalive, Node, NodeRecord } from "./schemas.ts";
import { Nodes } from "./service.ts";
import { NodesStore, RELEASED } from "./store.ts";

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
  sharesSnapshots: executor.sharesSnapshots,
});

/** How long a name that is refused is not told of again: a node that is set up wrong asks every few seconds. */
const REFUSAL_TOLD_EVERY = Duration.minutes(10);

export const makeNodes = Effect.fn("Nodes.make")(function* () {
  const store = yield* NodesStore;
  const settings = yield* Settings;
  const vault = yield* Vault;
  const events = yield* Events;
  const crypto = yield* Effect.context<Crypto.Crypto>();
  const silent = ago(settings.nodeSilentAfter);
  /** The digest of the registration token that is good without being made. */
  const given = Option.isNone(settings.registrationToken)
    ? Option.none<string>()
    : Option.some(yield* Secrets.hash(Redacted.value(settings.registrationToken.value)));

  /** The node with its operator token opened; none where it does not open. */
  const opened = Effect.fn(function* ({ operatorTokenSealed, ...node }: NodeRecord) {
    return yield* vault.open(operatorTokenSealed, node.name).pipe(
      Effect.map((operatorToken): Node => ({ ...node, operatorToken })),
      Effect.tapError((error) =>
        Effect.logWarning(`node ${node.name} cannot be driven: ${error.message}`),
      ),
      Effect.option,
    );
  });

  // A node whose name was let go has no token until the next to register under it gives one.
  const driven = (records: ReadonlyArray<NodeRecord>) =>
    Effect.forEach(
      records.filter((record) => record.operatorTokenSealed !== RELEASED),
      opened,
    ).pipe(Effect.map(Arr.getSomes));

  /** When a name that was refused was last told of. */
  const refusedAt = new Map<string, number>();

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
    yield* events.record({
      kind: "registration_token.created",
      resource: { kind: "registration_token", id: token.id, label: token.name },
    });
    return { token, secret };
  }, Effect.provide(crypto));

  const registrationTokens = Effect.fn("Nodes.registrationTokens")(function* () {
    return yield* store.listRegistrationTokens();
  });

  const revokeRegistrationToken = Effect.fn("Nodes.revokeRegistrationToken")(function* (
    id: string,
  ) {
    const token = yield* store.findRegistrationToken(id);
    if (Option.isNone(token)) {
      return yield* new RegistrationTokenNotFound({ id });
    }
    if (token.value.revokedAt !== null) {
      return;
    }
    yield* store.revokeRegistrationToken(id, yield* now);
    yield* events.record({
      kind: "registration_token.revoked",
      resource: { kind: "registration_token", id, label: token.value.name },
    });
  });

  /**
   * Whether a node says of itself what the node of that name said before, and registered
   * with that token: what a token that was taken back is still good for.
   */
  const unchanged = Effect.fn(function* (
    tokenId: string,
    said: Pick<NodeRecord, "name" | "internalUrl" | "balancerUrl" | "publicUrl"> & {
      readonly operatorToken: string;
    },
  ) {
    const known = yield* store.findByName(said.name);
    if (
      Option.isNone(known) ||
      known.value.registrationTokenId !== tokenId ||
      known.value.internalUrl !== said.internalUrl ||
      known.value.balancerUrl !== said.balancerUrl ||
      known.value.publicUrl !== said.publicUrl
    ) {
      return false;
    }
    const node = yield* opened(known.value);
    return Option.exists(node, (one) => one.operatorToken === said.operatorToken);
  });

  const keepalive = Effect.fn("Nodes.keepalive")(function* (said: Keepalive) {
    const hashed = yield* Secrets.hash(said.registrationToken);
    const token = yield* store.findRegistrationTokenByHash(hashed);
    // Digests are compared, so how long it takes tells nothing of the token.
    if (Option.isNone(token) && !Option.contains(given, hashed)) {
      return yield* new RegistrationRefused({ message: "that is no registration token" });
    }
    if (said.name.trim() === "") {
      return yield* new KeepaliveInvalid({ message: "the node has no name" });
    }
    if (said.operatorToken === "") {
      return yield* new KeepaliveInvalid({ message: "the node gave no operator token" });
    }
    const name = said.name.trim();
    const { address: from } = yield* Doer;
    const at = (what: string, given: string, path = false) =>
      Result.match(address(given, { what, from, path }), {
        onSuccess: Effect.succeed,
        onFailure: (message) => Effect.fail(new KeepaliveInvalid({ message })),
      });
    const optional = (what: string, given: string | undefined, path = false) =>
      given === undefined || given === "" ? Effect.succeed(null) : at(what, given, path);
    const internalUrl = yield* at("the internal address", said.internalUrl);
    const balancerUrl = yield* optional("the load balancer's address", said.balancerUrl);
    // People are sent there, and nothing here asks anything of it.
    const publicUrl = yield* optional("the public address", said.publicUrl, true);
    // Whoever has a token that was taken back makes no node with it, and sends no
    // session elsewhere by saying that a node moved.
    if (
      Option.isSome(token) &&
      token.value.revokedAt !== null &&
      !(yield* unchanged(token.value.id, {
        name,
        internalUrl,
        balancerUrl,
        publicUrl,
        operatorToken: said.operatorToken,
      }))
    ) {
      return yield* new RegistrationRefused({ message: "that registration token was revoked" });
    }
    const seen = {
      name,
      internalUrl,
      balancerUrl,
      publicUrl,
      registrationTokenId: Option.getOrNull(Option.map(token, (made) => made.id)),
      now: yield* now,
    };
    const sealed = vault.seal(said.operatorToken, name);
    const known = yield* store.findByName(name);
    // A registration token lets a node in under a name nobody has. A name that is taken
    // is its node's: whoever registers under it is the node only if it gives the operator
    // token the node gave, which nobody else was told. Otherwise any token, of any node
    // or one that leaked, would have a node's sessions and tickets sent to its holder.
    const kept = yield* Option.match(known, {
      onNone: () =>
        Effect.gen(function* () {
          const made = yield* store.register({
            ...seen,
            id: yield* Secrets.id,
            operatorTokenSealed: yield* sealed,
          });
          if (Option.isSome(made)) {
            yield* events.record({
              kind: "node.registered",
              resource: { kind: "node", id: made.value.id, label: made.value.name },
              detail: {
                internalUrl: made.value.internalUrl,
                registrationToken: token.pipe(
                  Option.map((one) => one.name),
                  Option.getOrNull,
                ),
              },
            });
          }
          return made;
        }),
      onSome: (node) =>
        Effect.gen(function* () {
          // A name an admin let go, or one whose token no longer opens, as after the
          // master key changed: the next to register under it gives the token it has.
          const holder =
            node.operatorTokenSealed === RELEASED ? Option.none() : yield* opened(node);
          if (Option.isNone(holder)) {
            return yield* store.seen(node.id, node.operatorTokenSealed, {
              ...seen,
              operatorTokenSealed: yield* sealed,
            });
          }
          // Digests are compared, so how long it takes tells nothing of the token.
          const its = yield* Secrets.hash(holder.value.operatorToken);
          if (!Secrets.same(its, yield* Secrets.hash(said.operatorToken))) {
            return Option.none();
          }
          return yield* store.seen(node.id, node.operatorTokenSealed, {
            ...seen,
            operatorTokenSealed: null,
          });
        }),
    });
    if (Option.isNone(kept)) {
      const at = DateTime.toEpochMillis(DateTime.fromDateUnsafe(seen.now));
      const told = refusedAt.get(name);
      if (
        Option.isSome(known) &&
        (told === undefined || at - told >= Duration.toMillis(REFUSAL_TOLD_EVERY))
      ) {
        refusedAt.set(name, at);
        yield* events.record({
          kind: "node.refused",
          resource: { kind: "node", id: known.value.id, label: name },
          detail: { internalUrl },
        });
      }
      return yield* new RegistrationRefused({
        message: `another node is registered as ${name}: a node keeps its name with the operator token it registered with, and an admin releases the name of one that was installed again`,
      });
    }
    const { operatorTokenSealed: _, ...node } = kept.value;
    return {
      node: { ...node, operatorToken: said.operatorToken } satisfies Node,
      againAfter: keepaliveEvery(settings),
    };
  }, Effect.provide(crypto));

  const release = Effect.fn("Nodes.release")(function* (id: string) {
    const node = yield* store.release(id);
    if (Option.isNone(node)) {
      return yield* new NodeNotFound({ id });
    }
    refusedAt.delete(node.value.name);
    yield* events.record({
      kind: "node.released",
      resource: { kind: "node", id, label: node.value.name },
    });
  });

  const list = Effect.fn("Nodes.list")(function* () {
    const since = yield* silent;
    const nodes = yield* store.list();
    return nodes.map((node) => ({
      node,
      alive: DateTime.toEpochMillis(node.lastSeenAt) > since.getTime(),
    }));
  });

  const alive = Effect.fn("Nodes.alive")(function* () {
    return yield* driven(yield* store.seenSince(yield* silent));
  });

  const candidates = Effect.fn("Nodes.candidates")(function* () {
    return yield* driven(yield* store.candidates(yield* silent));
  });

  const find = Effect.fn("Nodes.find")(function* (id: string) {
    const record = yield* store.find(id);
    return Option.isNone(record) || record.value.operatorTokenSealed === RELEASED
      ? Option.none<Node>()
      : yield* opened(record.value);
  });

  const describe = Effect.fn("Nodes.describe")(function* (node: Node, executor: proto.Executor) {
    yield* store.describe(node.id, offersOf(executor));
  });

  const noteSilent = Effect.fn("Nodes.noteSilent")(function* () {
    const fell = yield* store.noteSilent(yield* silent, yield* now);
    yield* Effect.forEach(
      fell,
      (node) =>
        events.record({
          kind: "node.silent",
          resource: { kind: "node", id: node.id, label: node.name },
          detail: { lastSeenAt: DateTime.formatIso(node.lastSeenAt) },
        }),
      { discard: true },
    );
  });

  const executor = (node: Node) => make({ url: node.internalUrl, token: node.operatorToken });

  return Nodes.of({
    createRegistrationToken,
    registrationTokens,
    revokeRegistrationToken,
    keepalive,
    release,
    list,
    alive,
    candidates,
    find,
    describe,
    noteSilent,
    executor,
  });
});

export const layer = Layer.effect(Nodes, makeNodes());
