import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
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

/** Resolve all session endpoints under the same mount, including relative relay mounts. */
export function sessionURL(access: SessionAccess, route: string): URL {
  const base = new URL(access.baseUrl ?? "/", window.location.href);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("session base URL must use HTTP or HTTPS");
  }
  if (access.kind === "relay" && base.origin !== window.location.origin) {
    throw new Error("session relay must use the page's origin");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/sessions/${encodeURIComponent(access.sessionId)}/${route}`;
  base.search = "";
  base.hash = "";
  return base;
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

/** GETs a session route with the credentials this access sends itself. */
function sessionGet(access: SessionAccess, route: string) {
  const { token, tenantId } = directAuthorization(access);
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (tenantId !== undefined) headers["X-Aperture-Tenant-Id"] = tenantId;
  return Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClient.filterStatusOk(http).get(sessionURL(access, route).toString(), { headers }),
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
  return yield* sessionGet(access, "browser/status").pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserStatus)),
    toApiRequestError,
  );
});

export const downloadSessionRecording = Effect.fn("downloadSessionRecording")(function* (
  access: SessionAccess,
  recordingId: string,
) {
  return yield* sessionGet(access, `recordings/${encodeURIComponent(recordingId)}/content`).pipe(
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
