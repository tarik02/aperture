import type { Offers } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { isAfter, Memory, moment, ordered } from "../store/memory.ts";
import type { NodeRecord, RegistrationToken } from "./schemas.ts";
import { type NewRegistrationToken, NodesStore, type SeenNode } from "./store.ts";

/** Nodes kept in memory. */
export const makeNodesStoreMemory = Effect.fn("NodesStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const registered = () => ordered(memory.nodes.values(), (node) => node.registeredAt);

  const insertRegistrationToken = Effect.fn("NodesStore.insertRegistrationToken")(
    (token: NewRegistrationToken) =>
      Effect.sync(() => {
        const kept: RegistrationToken = {
          id: token.id,
          name: token.name,
          createdAt: moment(token.createdAt),
          revokedAt: null,
        };
        memory.registrationTokens.set(token.tokenHash, kept);
        return kept;
      }),
  );

  const listRegistrationTokens = Effect.fn("NodesStore.listRegistrationTokens")(() =>
    Effect.sync(() => ordered(memory.registrationTokens.values(), (token) => token.createdAt)),
  );

  const findRegistrationToken = Effect.fn("NodesStore.findRegistrationToken")((id: string) =>
    Effect.sync(() =>
      Option.fromUndefinedOr(
        [...memory.registrationTokens.values()].find((token) => token.id === id),
      ),
    ),
  );

  const findRegistrationTokenByHash = Effect.fn("NodesStore.findRegistrationTokenByHash")(
    (tokenHash: string) =>
      Effect.sync(() => Option.fromUndefinedOr(memory.registrationTokens.get(tokenHash))),
  );

  const revokeRegistrationToken = Effect.fn("NodesStore.revokeRegistrationToken")(
    (id: string, now: Date) =>
      Effect.sync(() => {
        for (const [hash, token] of memory.registrationTokens) {
          if (token.id === id && token.revokedAt === null) {
            memory.registrationTokens.set(hash, { ...token, revokedAt: moment(now) });
          }
        }
      }),
  );

  const seen = Effect.fn("NodesStore.seen")((node: SeenNode) =>
    Effect.sync(() => {
      const known = [...memory.nodes.values()].find((one) => one.name === node.name);
      const kept: NodeRecord = {
        id: known?.id ?? node.id,
        name: node.name,
        internalUrl: node.internalUrl,
        balancerUrl: node.balancerUrl,
        publicUrl: node.publicUrl,
        operatorTokenSealed: node.operatorTokenSealed,
        offers: known?.offers ?? null,
        registrationTokenId: node.registrationTokenId,
        registeredAt: known?.registeredAt ?? moment(node.now),
        lastSeenAt: moment(node.now),
      };
      memory.nodes.set(kept.id, kept);
      memory.nodesSilent.delete(kept.id);
      return kept;
    }),
  );

  const describe = Effect.fn("NodesStore.describe")((id: string, offers: Offers) =>
    Effect.sync(() => {
      const node = memory.nodes.get(id);
      if (node !== undefined) {
        memory.nodes.set(id, { ...node, offers });
      }
    }),
  );

  const noteSilent = Effect.fn("NodesStore.noteSilent")((since: Date) =>
    Effect.sync(() => {
      const fell = [...memory.nodes.values()].filter(
        (node) => !isAfter(node.lastSeenAt, since) && !memory.nodesSilent.has(node.id),
      );
      for (const node of fell) {
        memory.nodesSilent.add(node.id);
      }
      return fell;
    }),
  );

  const list = Effect.fn("NodesStore.list")(() => Effect.sync(registered));

  const find = Effect.fn("NodesStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.nodes.get(id))),
  );

  const findByName = Effect.fn("NodesStore.findByName")((name: string) =>
    Effect.sync(() =>
      Option.fromUndefinedOr([...memory.nodes.values()].find((node) => node.name === name)),
    ),
  );

  const seenSince = Effect.fn("NodesStore.seenSince")((since: Date) =>
    Effect.sync(() => registered().filter((node) => isAfter(node.lastSeenAt, since))),
  );

  const candidates = Effect.fn("NodesStore.candidates")((since: Date) =>
    Effect.sync(() => {
      const sessions = (node: NodeRecord) =>
        [...memory.sessions.values()].filter((session) => session.nodeId === node.id).length;
      // The sort keeps the order of those that have as many sessions: the oldest first.
      return registered()
        .filter((node) => isAfter(node.lastSeenAt, since) && node.offers !== null)
        .toSorted((one, other) => sessions(one) - sessions(other));
    }),
  );

  return NodesStore.of({
    insertRegistrationToken,
    listRegistrationTokens,
    findRegistrationToken,
    findRegistrationTokenByHash,
    revokeRegistrationToken,
    seen,
    describe,
    noteSilent,
    list,
    find,
    findByName,
    seenSince,
    candidates,
  });
});

export const layerTest = Layer.effect(NodesStore, makeNodesStoreMemory());
