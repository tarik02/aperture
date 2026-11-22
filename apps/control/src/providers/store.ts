import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Endpoints, Kind, StoredProvider } from "./schemas.ts";

export interface NewProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  readonly issuer: string;
  readonly endpoints: Endpoints | null;
  readonly clientId: string;
  readonly clientSecretSealed: string;
  readonly scopes: ReadonlyArray<string>;
  readonly provision: boolean;
  readonly domains: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/**
 * A provider as it is from now on: all of it but what it is known by, what it speaks and
 * when it was added.
 */
export interface ChangedProvider extends Omit<NewProvider, "id" | "kind" | "createdAt"> {
  readonly updatedAt: Date;
}

/**
 * Where the providers an admin added are kept. Whatever changes them counts on: several
 * programs may share one database, and each learns by the count that what it signs people
 * in through is no more what is kept.
 */
export interface ProvidersStoreShape {
  /** Keeps a provider, unless one is known by its id already: then nothing is kept. */
  readonly insert: (provider: NewProvider) => Effect.Effect<Option.Option<StoredProvider>>;
  readonly list: () => Effect.Effect<ReadonlyArray<StoredProvider>>;
  readonly find: (id: string) => Effect.Effect<Option.Option<StoredProvider>>;
  readonly update: (
    id: string,
    changed: ChangedProvider,
  ) => Effect.Effect<Option.Option<StoredProvider>>;
  readonly delete: (id: string) => Effect.Effect<void>;
  /** How many times the providers were changed: another number than before, after any change. */
  readonly revision: () => Effect.Effect<number>;
}

export class ProvidersStore extends Context.Service<ProvidersStore, ProvidersStoreShape>()(
  "@aperture-browser/control/ProvidersStore",
) {}
