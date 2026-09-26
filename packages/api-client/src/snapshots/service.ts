import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { TagFilterValue } from "../query.ts";
import type { Snapshot, SnapshotMutationResponse } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface SnapshotsFilter {
  limit?: number;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
  name?: string;
  tags?: TagFilterValue;
}

export type SnapshotsListParams = SnapshotsFilter & PageCursor;

type SnapshotsList = PaginatedList<SnapshotsFilter, Snapshot>;

export interface UpdateSnapshotInput {
  description: string | null;
}

/** Retained snapshots that new sessions start from. */
export class SnapshotsApi extends Context.Service<
  SnapshotsApi,
  {
    readonly listSnapshots: SnapshotsList["list"];
    readonly streamSnapshots: SnapshotsList["stream"];
    readonly listAllSnapshots: SnapshotsList["listAll"];
    /** The active snapshot with exactly this name, if there is one. */
    readonly getSnapshotByName: (
      credentials: ApiCredentials,
      name: string,
    ) => Call<Option.Option<Snapshot>>;
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
