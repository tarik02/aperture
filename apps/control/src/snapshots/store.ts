import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Snapshot } from "./schemas.ts";

export interface NewSnapshot {
  readonly id: string;
  readonly accountId: string;
  readonly name: string | null;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly shared: boolean;
  readonly createdAt: Date;
}

/** Where the records of snapshots are kept: whose each is, and where it is found. */
export interface SnapshotsStoreShape {
  readonly insert: (snapshot: NewSnapshot) => Effect.Effect<Snapshot>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Snapshot>>;
  readonly list: () => Effect.Effect<ReadonlyArray<Snapshot>>;
  readonly listOf: (accountId: string) => Effect.Effect<ReadonlyArray<Snapshot>>;
  readonly delete: (id: string) => Effect.Effect<void>;
}

export class SnapshotsStore extends Context.Service<SnapshotsStore, SnapshotsStoreShape>()(
  "@aperture-browser/control/SnapshotsStore",
) {}
