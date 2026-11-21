import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Snapshot } from "./schemas.ts";

export interface NewSnapshot {
  readonly id: string;
  readonly accountId: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly shared: boolean;
  readonly createdAt: Date;
}

export interface SnapshotDescription {
  readonly name?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

/** Where the records of snapshots are kept: whose each is, and where it is found. */
export interface SnapshotsStoreShape {
  readonly insert: (snapshot: NewSnapshot) => Effect.Effect<Snapshot>;
  readonly find: (id: string) => Effect.Effect<Option.Option<Snapshot>>;
  readonly list: () => Effect.Effect<ReadonlyArray<Snapshot>>;
  readonly listOf: (accountId: string) => Effect.Effect<ReadonlyArray<Snapshot>>;
  /** Writes what a snapshot is called, said to be and tagged with; what is left out stays. */
  readonly describe: (id: string, said: SnapshotDescription) => Effect.Effect<void>;
  readonly delete: (id: string) => Effect.Effect<void>;
}

export class SnapshotsStore extends Context.Service<SnapshotsStore, SnapshotsStoreShape>()(
  "@aperture-browser/control/SnapshotsStore",
) {}
