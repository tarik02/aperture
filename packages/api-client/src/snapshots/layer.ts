import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture-browser/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { paginated } from "../pagination.ts";
import { compactQuery, tagQuery } from "../query.ts";
import type { Snapshot } from "../schemas.ts";
import {
  SnapshotsApi,
  type SnapshotsFilter,
  type SnapshotsListParams,
  type UpdateSnapshotInput,
} from "./service.ts";

export const makeSnapshotsApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const api = Api.make(httpClient);
  const tenantScoped = (credentials: ApiCredentials) =>
    authorize(Authorization.tenantScoped(credentials));

  const listSnapshots = Effect.fn("SnapshotsApi.listSnapshots")(function* (
    credentials: ApiCredentials,
    params: SnapshotsListParams = {},
  ) {
    return yield* api
      .listSnapshots({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          includeDeleted: params.includeDeleted || undefined,
          deleted: params.deleted,
          name: params.name,
          ...tagQuery(params.tags),
        }),
      })
      .pipe(tenantScoped(credentials));
  });

  const snapshots = paginated<SnapshotsFilter, Snapshot>(listSnapshots);

  // The API has no lookup by name; its name filter is a case-insensitive substring match,
  // so the exact name is picked from the filtered pages.
  const getSnapshotByName = Effect.fn("SnapshotsApi.getSnapshotByName")(function* (
    credentials: ApiCredentials,
    name: string,
  ) {
    return yield* snapshots.stream(credentials, { name, limit: 100 }).pipe(
      Stream.filter((candidate) => candidate.name === name),
      Stream.runHead,
    );
  });

  const updateSnapshot = Effect.fn("SnapshotsApi.updateSnapshot")(function* (
    credentials: ApiCredentials,
    name: string,
    input: UpdateSnapshotInput,
  ) {
    return yield* api.updateSnapshot(name, { payload: input }).pipe(tenantScoped(credentials));
  });

  const replaceSnapshotTags = Effect.fn("SnapshotsApi.replaceSnapshotTags")(function* (
    credentials: ApiCredentials,
    name: string,
    tags: Record<string, string>,
  ) {
    return yield* api
      .replaceSnapshotTags(name, { payload: { tags } })
      .pipe(tenantScoped(credentials));
  });

  const deleteSnapshot = Effect.fn("SnapshotsApi.deleteSnapshot")(function* (
    credentials: ApiCredentials,
    name: string,
  ) {
    return yield* api.deleteSnapshot(name, undefined).pipe(tenantScoped(credentials));
  });

  const restoreSnapshot = Effect.fn("SnapshotsApi.restoreSnapshot")(function* (
    credentials: ApiCredentials,
    name: string,
  ) {
    return yield* api.restoreSnapshot(name, undefined).pipe(tenantScoped(credentials));
  });

  return SnapshotsApi.of({
    listSnapshots,
    streamSnapshots: snapshots.stream,
    listAllSnapshots: snapshots.listAll,
    getSnapshotByName,
    updateSnapshot,
    replaceSnapshotTags,
    deleteSnapshot,
    restoreSnapshot,
  });
});

export const snapshotsApiLayer = Layer.effect(SnapshotsApi, makeSnapshotsApi);
