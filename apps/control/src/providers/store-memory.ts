import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { StoredProvider } from "./schemas.ts";
import { type ChangedProvider, type NewProvider, ProvidersStore } from "./store.ts";

/** Providers kept in memory. */
export const makeProvidersStoreMemory = Effect.fn("ProvidersStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const insert = Effect.fn("ProvidersStore.insert")((provider: NewProvider) =>
    Effect.sync(() => {
      if (memory.providers.has(provider.id)) {
        return Option.none<StoredProvider>();
      }
      const kept: StoredProvider = {
        ...provider,
        createdAt: moment(provider.createdAt),
        updatedAt: moment(provider.createdAt),
      };
      memory.providers.set(kept.id, kept);
      memory.providersRevision.count += 1;
      return Option.some(kept);
    }),
  );

  const list = Effect.fn("ProvidersStore.list")(() =>
    Effect.sync(() => ordered(memory.providers.values(), (provider) => provider.createdAt)),
  );

  const find = Effect.fn("ProvidersStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.providers.get(id))),
  );

  const update = Effect.fn("ProvidersStore.update")((id: string, changed: ChangedProvider) =>
    Effect.sync(() => {
      const found = memory.providers.get(id);
      if (found === undefined) {
        return Option.none<StoredProvider>();
      }
      const kept: StoredProvider = {
        ...found,
        ...changed,
        updatedAt: moment(changed.updatedAt),
      };
      memory.providers.set(id, kept);
      memory.providersRevision.count += 1;
      return Option.some(kept);
    }),
  );

  const delete_ = Effect.fn("ProvidersStore.delete")((id: string) =>
    Effect.sync(() => {
      memory.providers.delete(id);
      memory.providersRevision.count += 1;
    }),
  );

  const revision = Effect.fn("ProvidersStore.revision")(() =>
    Effect.sync(() => memory.providersRevision.count),
  );

  return ProvidersStore.of({ insert, list, find, update, delete: delete_, revision });
});

export const layerTest = Layer.effect(ProvidersStore, makeProvidersStoreMemory());
