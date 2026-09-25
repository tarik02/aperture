import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Api from "@aperture-browser/api-schema";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { TagFilterValue } from "../query.ts";
import type {
  BrowserChannelsResponse,
  CreateSessionResponse,
  CursorVisibility,
  PromoteSessionResponse,
  ProxyConfig,
  Session,
  SessionFile,
  SessionFileDownloadURL,
  SessionMutationResponse,
  SessionRecording,
  SessionsBulkResponse,
  UpdateProxyConfig,
} from "../schemas.ts";
import type { BrowserStatus } from "./schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export interface SessionsFilter {
  limit?: number;
  includeDeleted?: boolean;
  status?: Api.SessionStatus;
  tags?: TagFilterValue;
}

export type SessionsListParams = SessionsFilter & PageCursor;

type SessionsList = PaginatedList<SessionsFilter, Session>;

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

export type CreateSessionRecordingInput = Api.CreateSessionRecordingInput;
export type SessionFileDownloadURLInput = Api.SessionFileDownloadURLInput;

export interface DownloadedFile {
  blob: Blob;
  filename: string | null;
}

/** Browser sessions, their live browser, and their recordings. */
export class SessionsApi extends Context.Service<
  SessionsApi,
  {
    readonly listSessions: SessionsList["list"];
    readonly streamSessions: SessionsList["stream"];
    readonly listAllSessions: SessionsList["listAll"];
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
    readonly getSessionCursor: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<CursorVisibility>;
    readonly setSessionCursor: (
      credentials: ApiCredentials,
      sessionId: string,
      visible: boolean,
    ) => Call<CursorVisibility>;
    readonly listSessionRecordings: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<ReadonlyArray<SessionRecording>>;
    readonly createSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      input: CreateSessionRecordingInput,
    ) => Call<SessionRecording>;
    readonly getSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
    ) => Call<SessionRecording>;
    /** Moves a running tab recording to another ready target. */
    readonly retargetSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
      targetId: string,
    ) => Call<SessionRecording>;
    /** Stops a recording and returns the session file it was saved to. */
    readonly stopSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
    ) => Call<SessionFile>;
    /** A signed URL that downloads one session file without credentials until it expires. */
    readonly createSessionFileDownloadURL: (
      credentials: ApiCredentials,
      sessionId: string,
      input: SessionFileDownloadURLInput,
    ) => Call<SessionFileDownloadURL>;
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
