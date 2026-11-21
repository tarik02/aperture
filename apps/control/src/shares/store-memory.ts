import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { isAfter, Memory, moment, ordered } from "../store/memory.ts";
import type { Share } from "./schemas.ts";
import { type NewShare, SharesStore } from "./store.ts";

/** Share links kept in memory. */
export const makeSharesStoreMemory = Effect.fn("SharesStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const byId = (id: string) => [...memory.shares].find(([, share]) => share.id === id);

  const insert = Effect.fn("SharesStore.insert")((share: NewShare) =>
    Effect.sync(() => {
      const { tokenHash, ...told } = share;
      const kept: Share = {
        ...told,
        createdAt: moment(share.createdAt),
        expiresAt: share.expiresAt === null ? null : moment(share.expiresAt),
        lastUsedAt: null,
      };
      memory.shares.set(tokenHash, kept);
      return kept;
    }),
  );

  const listOf = Effect.fn("SharesStore.listOf")((sessionId: string) =>
    Effect.sync(() =>
      ordered(memory.shares.values(), (share) => share.createdAt).filter(
        (share) => share.sessionId === sessionId,
      ),
    ),
  );

  const listBy = Effect.fn("SharesStore.listBy")((accountId: string) =>
    Effect.sync(() =>
      ordered(memory.shares.values(), (share) => share.createdAt).filter(
        (share) => share.accountId === accountId,
      ),
    ),
  );

  const find = Effect.fn("SharesStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(byId(id)?.[1])),
  );

  const findByTokenHash = Effect.fn("SharesStore.findByTokenHash")((tokenHash: string, now: Date) =>
    Effect.sync(() =>
      Option.fromUndefinedOr(memory.shares.get(tokenHash)).pipe(
        Option.filter(
          (share) =>
            (share.expiresAt === null || isAfter(share.expiresAt, now)) &&
            (memory.accounts.get(share.accountId)?.disabledAt ?? null) === null,
        ),
      ),
    ),
  );

  const delete_ = Effect.fn("SharesStore.delete")((id: string) =>
    Effect.sync(() => {
      const found = byId(id);
      if (found !== undefined) {
        memory.shares.delete(found[0]);
      }
    }),
  );

  const used = Effect.fn("SharesStore.used")((id: string, now: Date, since: Date) =>
    Effect.sync(() => {
      const found = byId(id);
      if (
        found !== undefined &&
        (found[1].lastUsedAt === null || !isAfter(found[1].lastUsedAt, since))
      ) {
        memory.shares.set(found[0], { ...found[1], lastUsedAt: moment(now) });
      }
    }),
  );

  return SharesStore.of({
    insert,
    listOf,
    listBy,
    find,
    findByTokenHash,
    delete: delete_,
    used,
  });
});

export const layerTest = Layer.effect(SharesStore, makeSharesStoreMemory());
