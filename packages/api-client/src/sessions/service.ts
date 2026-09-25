import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Api from "@aperture-browser/api-schema";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { TagFilterValue } from "../query.ts";
import type {
  BrowserChannelsResponse,
  CreateSessionResponse,
  PromoteSessionResponse,
  ProxyConfig,
  Session,
  SessionMutationResponse,
  SessionsBulkResponse,
  SessionsPage,
  UpdateProxyConfig,
} from "../schemas.ts";
import type { BrowserStatus } from "./schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface SessionsListParams {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  status?: Api.SessionStatus;
  tags?: TagFilterValue;
}

export type SessionsFilter = Omit<SessionsListParams, "cursor">;

export type InitialBrowserTarget = Api.InitialBrowserTarget;
export type InitialBrowserStorageState = Api.InitialBrowserStorageState;

export interface CreateSessionInput {
  baseSnapshotName?: string | null;
  label?: string | null;
  browser: {
    channel: string;
    args?: string[];
  };
  initialTargets?: readonly InitialBrowserTarget[];
  storageState?: InitialBrowserStorageState;
  tags?: Record<string, string>;
  proxy?: ProxyConfig;
}

export interface CreateSessionOptions {
  waitForReady?: boolean;
}

export interface PromoteSessionInput {
  name: string;
  description?: string | null;
  force?: boolean;
  tags?: Record<string, string>;
}

export interface DownloadedFile {
  blob: Blob;
  filename: string | null;
}

/** Browser sessions, their live browser, and their recordings. */
export class SessionsApi extends Context.Service<
  SessionsApi,
  {
    readonly listSessions: (
      credentials: ApiCredentials,
      params?: SessionsListParams,
    ) => Call<SessionsPage>;
    /** Every matching session, fetching pages as the stream is pulled. */
    readonly streamSessions: (
      credentials: ApiCredentials,
      filter?: SessionsFilter,
    ) => Stream.Stream<Session, ApiRequestError>;
    readonly listAllSessions: (
      credentials: ApiCredentials,
      filter?: SessionsFilter,
    ) => Call<ReadonlyArray<Session>>;
    readonly getSession: (credentials: ApiCredentials, sessionId: string) => Call<Session>;
    readonly getSessionsBulk: (
      credentials: ApiCredentials,
      sessionIds: readonly string[],
    ) => Call<SessionsBulkResponse>;
    readonly createSession: (
      credentials: ApiCredentials,
      input: CreateSessionInput,
      options?: CreateSessionOptions,
    ) => Call<CreateSessionResponse>;
    readonly deleteSession: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<SessionMutationResponse>;
    readonly reopenSession: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<SessionMutationResponse>;
    readonly suspendSession: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<SessionMutationResponse>;
    readonly rotateSessionToken: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<SessionMutationResponse>;
    readonly rotateCollaborationCapability: (
      credentials: ApiCredentials,
      sessionId: string,
      role: "editor" | "viewer",
    ) => Call<SessionMutationResponse>;
    readonly replaceSessionTags: (
      credentials: ApiCredentials,
      sessionId: string,
      tags: Record<string, string>,
    ) => Call<SessionMutationResponse>;
    /** Replaces the session's egress proxy; new connections use it immediately. */
    readonly updateSessionProxy: (
      credentials: ApiCredentials,
      sessionId: string,
      proxy: UpdateProxyConfig,
    ) => Call<SessionMutationResponse>;
    readonly promoteSession: (
      credentials: ApiCredentials,
      sessionId: string,
      input: PromoteSessionInput,
    ) => Call<PromoteSessionResponse>;
    readonly getBrowserChannels: (credentials: ApiCredentials) => Call<BrowserChannelsResponse>;
    readonly getBrowserStatus: (
      credentials: ApiCredentials,
      sessionId: string,
      sessionToken?: string,
    ) => Call<BrowserStatus>;
    readonly downloadSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
      sessionToken?: string,
    ) => Call<DownloadedFile>;
  }
>()("@aperture-browser/api-client/SessionsApi") {}
