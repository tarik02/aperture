import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
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
  return mountURL(access, `sessions/${encodeURIComponent(access.sessionId)}/${route}`);
}

export function sessionWebSocketURL(access: SessionAccess, route: string): string {
  const url = sessionURL(access, route);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Credentials the browser sends itself; relay access is authenticated by the consumer backend instead. */
function directAuthorization(access: SessionAccess) {
  if (access.kind !== "direct") {
    return { token: undefined, tenantId: undefined };
  }
  const { credentials } = access;
  return {
    token: credentials.kind === "bearer" ? Redacted.value(credentials.token) : undefined,
    tenantId: resolveTenantHeader(credentials, "tenant-scoped"),
  };
}

export function sessionProtocols(access: SessionAccess): string[] {
  const { token, tenantId } = directAuthorization(access);
  const protocols = [LIVE_SESSION_PROTOCOL];
  if (token !== undefined) {
    protocols.push(`authorization.bearer.${token}`);
  }
  if (tenantId !== undefined) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return protocols;
}

/** GETs a session route with the credentials this access sends itself. */
function sessionGet(access: SessionAccess, url: URL) {
  const { token, tenantId } = directAuthorization(access);
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (tenantId !== undefined) {
    headers["X-Aperture-Tenant-Id"] = tenantId;
  }
  return Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClient.filterStatusOk(http).get(url.toString(), { headers }),
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      // Bearer access must not also carry the page's cookies; relay and cookie access need them.
      credentials: token === undefined ? "same-origin" : "omit",
      redirect: "error",
      cache: "no-store",
    }),
  );
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
    sessionURL(access, `recordings/${encodeURIComponent(recordingId)}/content`),
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
  const route = `targets/${encodeURIComponent(targetId)}/thumbnail`;
  const token = directAuthorization(access).token;
  const usesSessionRoute =
    access.kind === "relay" ||
    (token !== undefined &&
      (token.startsWith("aps_") || token.startsWith("ape_") || token.startsWith("apv_")));
  const url = usesSessionRoute
    ? sessionURL(access, route)
    : mountURL(access, `api/sessions/${encodeURIComponent(access.sessionId)}/${route}`);
  return yield* sessionGet(access, url).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.arrayBuffer, (body) => new Blob([body], { type: "image/jpeg" })),
    ),
    toApiRequestError,
  );
});
