import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { TagFilterValue } from "../query.ts";
import type { SnapshotMutationResponse, SnapshotsPage } from "../schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface SnapshotsListParams {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
  name?: string;
  tags?: TagFilterValue;
}

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
>()("@aperture/api-client/SnapshotsApi") {}
