import { Effect, Layer } from "effect";
import * as Api from "@aperture/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { compactQuery, tagQuery } from "../query.ts";
import { SnapshotsApi, type SnapshotsListParams, type UpdateSnapshotInput } from "./service.ts";

export const makeSnapshotsApi = Effect.gen(function* () {
  const { httpClient, authorize } = yield* ApiAuthorization;
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
    updateSnapshot,
    replaceSnapshotTags,
    deleteSnapshot,
    restoreSnapshot,
  });
});

export const snapshotsApiLayer = Layer.effect(SnapshotsApi, makeSnapshotsApi);
