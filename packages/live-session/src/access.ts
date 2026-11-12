import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  BrowserStatus,
  contentDispositionFilename,
  resolveTenantHeader,
  toApiRequestError,
  type ApiCredentials,
  type DownloadedFile,
} from "@aperture-browser/api-client";
import { LIVE_SESSION_PROTOCOL } from "./protocol.ts";
import * as UrlPath from "@aperture-browser/api-client/url-path";

/** Where this browser connects, and who authenticates it. */
export type SessionAccess =
  | {
      readonly kind: "direct";
      readonly baseUrl?: string;
      readonly sessionId: string;
      readonly credentials: ApiCredentials;
    }
  | {
      readonly kind: "relay";
      readonly baseUrl: string;
      readonly sessionId: string;
    };

/** Resolve a path under the access mount, including relative relay mounts. */
function mountURL(access: SessionAccess, path: string): URL {
  const base = new URL(access.baseUrl ?? "/", window.location.href);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("session base URL must use HTTP or HTTPS");
  }
  if (access.kind === "relay" && base.origin !== window.location.origin) {
    throw new Error("session relay must use the page's origin");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${path}`;
  base.search = "";
  base.hash = "";
  return base;
}

/** Resolve all session endpoints under the same mount. */
export function sessionURL(access: SessionAccess, route: string): URL {
  return mountURL(access, UrlPath.make`sessions/${access.sessionId}/${UrlPath.raw(route)}`);
}

export function sessionWebSocketURL(access: SessionAccess, route: string): string {
  const url = sessionURL(access, route);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Credentials the browser sends itself; relay access is authenticated by the consumer backend instead. */
function directAuthorization(access: SessionAccess) {
  if (access.kind !== "direct") return { token: undefined, tenantId: undefined };
  const { credentials } = access;
  return {
    token: credentials.kind === "bearer" ? Redacted.value(credentials.token) : undefined,
    tenantId: resolveTenantHeader(credentials, "tenant-scoped"),
  };
}

export function sessionProtocols(access: SessionAccess): string[] {
  const { token, tenantId } = directAuthorization(access);
  const protocols = [LIVE_SESSION_PROTOCOL];
  if (token !== undefined) protocols.push(`authorization.bearer.${token}`);
  if (tenantId !== undefined) protocols.push(`x-aperture-tenant-id.${tenantId}`);
  return protocols;
}

/** Sends a session request with the credentials this access sends itself. */
function sessionRequest(access: SessionAccess, request: HttpClientRequest.HttpClientRequest) {
  const { token, tenantId } = directAuthorization(access);
  let authorized = request;
  if (token !== undefined) authorized = HttpClientRequest.bearerToken(authorized, token);
  if (tenantId !== undefined) {
    authorized = HttpClientRequest.setHeader(authorized, "X-Aperture-Tenant-Id", tenantId);
  }
  return Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClient.filterStatusOk(http).execute(authorized),
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      // Bearer access must not also carry the page's cookies; relay and cookie access need them.
      credentials: token === undefined ? "same-origin" : "omit",
      redirect: "error",
      cache: "no-store",
    }),
  );
}

/** GETs a session route with the credentials this access sends itself. */
function sessionGet(access: SessionAccess, url: URL) {
  return sessionRequest(access, HttpClientRequest.get(url.toString()));
}

export const getSessionStatus = Effect.fn("getSessionStatus")(function* (access: SessionAccess) {
  return yield* sessionGet(access, sessionURL(access, "browser/status")).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserStatus)),
    toApiRequestError,
  );
});

export const downloadSessionRecording = Effect.fn("downloadSessionRecording")(function* (
  access: SessionAccess,
  recordingId: string,
) {
  return yield* sessionGet(
    access,
    sessionURL(access, UrlPath.make`recordings/${recordingId}/content`),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.map(
        response.arrayBuffer,
        (body): DownloadedFile => ({
          blob: new Blob([body], { type: response.headers["content-type"] ?? "" }),
          filename: contentDispositionFilename(response.headers["content-disposition"]),
        }),
      ),
    ),
    toApiRequestError,
  );
});

/** A JPEG of one tab, authorized through the relay, session access, or account API. */
export const getTargetThumbnail = Effect.fn("getTargetThumbnail")(function* (
  access: SessionAccess,
  targetId: string,
) {
  const route = UrlPath.make`targets/${targetId}/thumbnail`;
  const token = directAuthorization(access).token;
  const usesSessionRoute =
    access.kind === "relay" ||
    (token !== undefined &&
      (token.startsWith("aps_") || token.startsWith("ape_") || token.startsWith("apv_")));
  const url = usesSessionRoute
    ? sessionURL(access, route)
    : mountURL(access, UrlPath.make`api/sessions/${access.sessionId}/${UrlPath.raw(route)}`);
  return yield* sessionGet(access, url).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.arrayBuffer, (body) => new Blob([body], { type: "image/jpeg" })),
    ),
    toApiRequestError,
  );
});

/** The session files directory clipboard data passes through; the browser deletes what is left. */
const CLIPBOARD_DIRECTORY = "clipboard";

/** Whether this access reaches the session files API, which clipboard data too large for a
 * session message passes through. Relays do not forward it. */
export const reachesSessionFiles = (access: SessionAccess) => access.kind === "direct";

function sessionFilesURL(access: SessionAccess, route = "") {
  return mountURL(
    access,
    UrlPath.make`api/sessions/${access.sessionId}/files${UrlPath.raw(route)}`,
  );
}

const UploadedFiles = Schema.Struct({
  files: Schema.Array(Schema.Struct({ relativePath: Schema.String })),
});

const DownloadURL = Schema.Struct({ url: Schema.String });

/** Stores data for a paste in the clipboard directory and returns its relative path. */
export const uploadClipboardFile = Effect.fn("uploadClipboardFile")(function* (
  access: SessionAccess,
  data: Blob,
) {
  const form = new FormData();
  form.append("files", data, `paste-${crypto.randomUUID()}`);
  const request = HttpClientRequest.post(sessionFilesURL(access).toString()).pipe(
    HttpClientRequest.setUrlParam("directory", CLIPBOARD_DIRECTORY),
    HttpClientRequest.bodyFormData(form),
  );
  const uploaded = yield* sessionRequest(access, request).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UploadedFiles)),
    toApiRequestError,
  );
  return uploaded.files[0]?.relativePath;
});

/** Deletes a clipboard file; one the browser already deleted counts as deleted. */
export const deleteClipboardFile = Effect.fn("deleteClipboardFile")(function* (
  access: SessionAccess,
  relativePath: string,
) {
  const request = HttpClientRequest.make("DELETE")(sessionFilesURL(access).toString()).pipe(
    HttpClientRequest.setUrlParam("relativePath", relativePath),
  );
  yield* sessionRequest(access, request).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      error.response?.status === 404 ? Effect.void : Effect.fail(error),
    ),
    toApiRequestError,
  );
});

/** Downloads the clipboard file the browser stored for a copy, then deletes it. */
export const takeClipboardFile = Effect.fn("takeClipboardFile")(function* (
  access: SessionAccess,
  relativePath: string,
  mimeType: string,
) {
  const download = Effect.gen(function* () {
    const { url } = yield* sessionRequest(
      access,
      HttpClientRequest.post(sessionFilesURL(access, "/download-url").toString()).pipe(
        HttpClientRequest.bodyJsonUnsafe({ relativePath, ttlSeconds: 60 }),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(DownloadURL)));
    // The signed URL is the credential.
    const response = yield* Effect.flatMap(HttpClient.HttpClient, (http) =>
      HttpClient.filterStatusOk(http).get(url),
    ).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
    const body = yield* response.arrayBuffer;
    return new Blob([body], { type: mimeType });
  }).pipe(toApiRequestError);
  return yield* download.pipe(
    Effect.ensuring(Effect.ignore(deleteClipboardFile(access, relativePath))),
  );
});
