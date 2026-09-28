import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  BrowserStatus,
  resolveTenantHeader,
  toApiRequestError,
  type ApiCredentials,
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

export function sessionProtocols(access: SessionAccess): string[] {
  const protocols = [LIVE_SESSION_PROTOCOL];
  if (access.kind === "direct") {
    if (access.credentials.kind === "bearer") {
      protocols.push(`authorization.bearer.${Redacted.value(access.credentials.token)}`);
    }
    const tenantId = resolveTenantHeader(access.credentials, "tenant-scoped");
    if (tenantId !== undefined) {
      protocols.push(`x-aperture-tenant-id.${tenantId}`);
    }
  }
  return protocols;
}

export const getSessionStatus = Effect.fn("getSessionStatus")(function* (access: SessionAccess) {
  const http = yield* HttpClient.HttpClient;
  const headers: Record<string, string> = {};
  if (access.kind === "direct") {
    if (access.credentials.kind === "bearer") {
      headers.Authorization = `Bearer ${Redacted.value(access.credentials.token)}`;
    }
    const tenantId = resolveTenantHeader(access.credentials, "tenant-scoped");
    if (tenantId !== undefined) {
      headers["X-Aperture-Tenant-Id"] = tenantId;
    }
  }
  return yield* HttpClient.filterStatusOk(http)
    .get(sessionURL(access, "browser/status").toString(), { headers })
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserStatus)),
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials:
          access.kind === "direct" && access.credentials.kind === "bearer" ? "omit" : "same-origin",
        redirect: "error",
        cache: "no-store",
      }),
      toApiRequestError,
    );
});
