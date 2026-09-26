import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
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
  SessionDirectory,
  SessionFile,
  SessionFileDownloadURL,
  SessionFileEntry,
  SessionMutationResponse,
  SessionRecording,
  SessionsBulkResponse,
  SetViewportInput,
  TargetViewport,
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

/**
 * One file to upload. Blob and Uint8Array contents are sent as FormData. Any stream content
 * makes the whole body a streamed request, which browsers other than Chromium cannot send;
 * a stream failure aborts the upload and surfaces as a `network_error`.
 */
export interface SessionUploadFile {
  name: string;
  content: Blob | Uint8Array | Stream.Stream<Uint8Array, unknown>;
}

export interface UploadSessionFilesOptions {
  /** Directory below the session files root; `uploads` when omitted. */
  directory?: string;
}

export type MoveSessionFileInput = Api.MoveSessionFileInput;

export interface DeleteSessionFileOptions {
  /** Delete a directory together with everything below it. */
  recursive?: boolean;
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
    /**
     * Every file and directory of the session, also while it is not running. See
     * `sessionFileTree`.
     */
    readonly listSessionFiles: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<ReadonlyArray<SessionFileEntry>>;
    /**
     * Stores files in a directory of the session's files, `uploads` by default, in any
     * retained state. Contents are sent as described for `SessionUploadFile`.
     */
    readonly uploadSessionFiles: (
      credentials: ApiCredentials,
      sessionId: string,
      files: ReadonlyArray<SessionUploadFile>,
      options?: UploadSessionFilesOptions,
    ) => Call<ReadonlyArray<SessionFile>>;
    /** Deletes one file, or a directory; a directory with entries needs `recursive`. */
    readonly deleteSessionFile: (
      credentials: ApiCredentials,
      sessionId: string,
      relativePath: string,
      options?: DeleteSessionFileOptions,
    ) => Call<void>;
    /** Moves or renames one file or directory. It never replaces an existing entry. */
    readonly moveSessionFile: (
      credentials: ApiCredentials,
      sessionId: string,
      input: MoveSessionFileInput,
    ) => Call<SessionFileEntry>;
    /** Creates a directory, with any missing parents. */
    readonly createSessionDirectory: (
      credentials: ApiCredentials,
      sessionId: string,
      relativePath: string,
    ) => Call<SessionDirectory>;
    /**
     * A signed URL that serves one session file without credentials until it expires.
     * `disposition: "inline"` makes it usable as an `<img>` or `<video>` source.
     */
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
    /** The recording's bytes as they arrive, for files too large to hold in memory. */
    readonly streamSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
      sessionToken?: string,
    ) => Stream.Stream<Uint8Array, ApiRequestError>;
    /**
     * Stores files in the running session's `uploads` directory through the session itself,
     * which also accepts its `sessionToken`.
     */
    readonly uploadLiveSessionFiles: (
      credentials: ApiCredentials,
      sessionId: string,
      files: ReadonlyArray<SessionUploadFile>,
      sessionToken?: string,
    ) => Call<ReadonlyArray<SessionFile>>;
    /** Resizes a top-level target of the running session and returns the applied viewport. */
    readonly setSessionViewport: (
      credentials: ApiCredentials,
      sessionId: string,
      input: SetViewportInput,
      sessionToken?: string,
    ) => Call<TargetViewport>;
  }
>()("@aperture-browser/api-client/SessionsApi") {}
