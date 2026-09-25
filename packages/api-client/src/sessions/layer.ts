import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Api from "@aperture/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { compactQuery, tagQuery } from "../query.ts";
import { BrowserStatus } from "./schemas.ts";
import {
  SessionsApi,
  type CreateSessionInput,
  type CreateSessionOptions,
  type DownloadedFile,
  type PromoteSessionInput,
  type SessionsListParams,
} from "./service.ts";

const contentDispositionFilename = (header: string | undefined): string | null =>
  header?.match(/filename="([^"]+)"/)?.[1] ?? null;

export const makeSessionsApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const http = HttpClient.filterStatusOk(httpClient);
  const api = Api.make(httpClient);
  const tenantScoped = (credentials: ApiCredentials) =>
    authorize(Authorization.tenantScoped(credentials));

  const listSessions = Effect.fn("SessionsApi.listSessions")(function* (
    credentials: ApiCredentials,
    params: SessionsListParams = {},
  ) {
    return yield* api
      .listSessions({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          includeDeleted: params.includeDeleted || undefined,
          status: params.status,
          ...tagQuery(params.tags),
        }),
      })
      .pipe(tenantScoped(credentials));
  });

  const getSession = Effect.fn("SessionsApi.getSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api.getSession(sessionId, undefined).pipe(tenantScoped(credentials));
  });

  const getSessionsBulk = Effect.fn("SessionsApi.getSessionsBulk")(function* (
    credentials: ApiCredentials,
    sessionIds: readonly string[],
  ) {
    return yield* api
      .getSessionsBulk({ payload: { ids: sessionIds } })
      .pipe(tenantScoped(credentials));
  });

  const createSession = Effect.fn("SessionsApi.createSession")(function* (
    credentials: ApiCredentials,
    input: CreateSessionInput,
    options: CreateSessionOptions = {},
  ) {
    return yield* api
      .createSession({
        params: compactQuery({ waitForReady: options.waitForReady }),
        payload: {
          baseSnapshotName: input.baseSnapshotName ?? null,
          label: input.label ?? null,
          browser: { channel: input.browser.channel, args: input.browser.args ?? [] },
          initialTargets: input.initialTargets ?? [],
          ...(input.storageState === undefined ? {} : { storageState: input.storageState }),
          tags: input.tags ?? {},
        },
      })
      .pipe(tenantScoped(credentials));
  });

  const deleteSession = Effect.fn("SessionsApi.deleteSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api.deleteSession(sessionId, undefined).pipe(tenantScoped(credentials));
  });

  const reopenSession = Effect.fn("SessionsApi.reopenSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api.reopenSession(sessionId, undefined).pipe(tenantScoped(credentials));
  });

  const suspendSession = Effect.fn("SessionsApi.suspendSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api.suspendSession(sessionId, undefined).pipe(tenantScoped(credentials));
  });

  const rotateSessionToken = Effect.fn("SessionsApi.rotateSessionToken")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api.rotateSessionToken(sessionId, undefined).pipe(tenantScoped(credentials));
  });

  const rotateCollaborationCapability = Effect.fn("SessionsApi.rotateCollaborationCapability")(
    function* (credentials: ApiCredentials, sessionId: string, role: "editor" | "viewer") {
      return yield* api
        .rotateCollaborationCapability(sessionId, role, undefined)
        .pipe(tenantScoped(credentials));
    },
  );

  const replaceSessionTags = Effect.fn("SessionsApi.replaceSessionTags")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    tags: Record<string, string>,
  ) {
    return yield* api
      .replaceSessionTags(sessionId, { payload: { tags } })
      .pipe(tenantScoped(credentials));
  });

  const promoteSession = Effect.fn("SessionsApi.promoteSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    input: PromoteSessionInput,
  ) {
    return yield* api
      .promoteSession(sessionId, {
        payload: {
          name: input.name,
          description: input.description ?? null,
          force: input.force ?? false,
          tags: input.tags ?? {},
        },
      })
      .pipe(tenantScoped(credentials));
  });

  const getBrowserChannels = Effect.fn("SessionsApi.getBrowserChannels")(function* (
    credentials: ApiCredentials,
  ) {
    return yield* api.listBrowserChannels(undefined).pipe(tenantScoped(credentials));
  });

  const getBrowserStatus = Effect.fn("SessionsApi.getBrowserStatus")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    sessionToken?: string,
  ) {
    return yield* http
      .get(`/sessions/${encodeURIComponent(sessionId)}/browser/status`)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserStatus)),
        authorize({ credentials, bearerToken: sessionToken }),
      );
  });

  const downloadSessionRecording = Effect.fn("SessionsApi.downloadSessionRecording")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    recordingId: string,
    sessionToken?: string,
  ) {
    return yield* http
      .get(
        `/sessions/${encodeURIComponent(sessionId)}/recordings/${encodeURIComponent(recordingId)}/content`,
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(
            response.arrayBuffer,
            (body): DownloadedFile => ({
              blob: new Blob([body], { type: response.headers["content-type"] ?? "" }),
              filename: contentDispositionFilename(response.headers["content-disposition"]),
            }),
          ),
        ),
        authorize({ credentials, bearerToken: sessionToken, tenantHeader: "tenant-scoped" }),
      );
  });

  return SessionsApi.of({
    listSessions,
    getSession,
    getSessionsBulk,
    createSession,
    deleteSession,
    reopenSession,
    suspendSession,
    rotateSessionToken,
    rotateCollaborationCapability,
    replaceSessionTags,
    promoteSession,
    getBrowserChannels,
    getBrowserStatus,
    downloadSessionRecording,
  });
});

export const sessionsApiLayer = Layer.effect(SessionsApi, makeSessionsApi);
