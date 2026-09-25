import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { TagFilterValue } from "../query.ts";
import type { Snapshot, SnapshotMutationResponse, SnapshotsPage } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface SnapshotsListParams {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
  name?: string;
  tags?: TagFilterValue;
}

export type SnapshotsFilter = Omit<SnapshotsListParams, "cursor">;

export interface UpdateSnapshotInput {
  description: string | null;
}

/** Retained snapshots that new sessions start from. */
export class SnapshotsApi extends Context.Service<
  SnapshotsApi,
  {
    readonly listSnapshots: (
      credentials: ApiCredentials,
      params?: SnapshotsListParams,
    ) => Call<SnapshotsPage>;
    /** Every matching snapshot, fetching pages as the stream is pulled. */
    readonly streamSnapshots: (
      credentials: ApiCredentials,
      filter?: SnapshotsFilter,
    ) => Stream.Stream<Snapshot, ApiRequestError>;
    readonly listAllSnapshots: (
      credentials: ApiCredentials,
      filter?: SnapshotsFilter,
    ) => Call<ReadonlyArray<Snapshot>>;
    /** The active snapshot with exactly this name; fails with `snapshot_not_found` (404). */
    readonly getSnapshotByName: (credentials: ApiCredentials, name: string) => Call<Snapshot>;
    readonly updateSnapshot: (
      credentials: ApiCredentials,
      name: string,
      input: UpdateSnapshotInput,
    ) => Call<SnapshotMutationResponse>;
    readonly replaceSnapshotTags: (
      credentials: ApiCredentials,
      name: string,
      tags: Record<string, string>,
    ) => Call<SnapshotMutationResponse>;
    readonly deleteSnapshot: (
      credentials: ApiCredentials,
      name: string,
    ) => Call<SnapshotMutationResponse>;
    readonly restoreSnapshot: (
      credentials: ApiCredentials,
      name: string,
    ) => Call<SnapshotMutationResponse>;
  }
>()("@aperture-browser/api-client/SnapshotsApi") {}
