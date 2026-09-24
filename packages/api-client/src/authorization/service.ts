import { Context, type Effect, type Schema, type Stream } from "effect";
import type { HttpClient, HttpClientError } from "effect/unstable/http";
import type { ApiRequestError } from "../errors.ts";

export const TENANT_HEADER = "X-Aperture-Tenant-Id";

type CredentialContext = {
  authorityType: "system_admin" | "tenant" | null;
  tenantId: string | null;
  selectedTenantId: string | null;
};

export type ApiCredentials =
  | (CredentialContext & {
      kind: "bearer";
      token: string;
    })
  | (CredentialContext & {
      kind: "session";
    });

/** The browser's own login session, sent as a cookie. */
export const webSessionCredentials: ApiCredentials = {
  kind: "session",
  authorityType: null,
  tenantId: null,
  selectedTenantId: null,
};

export type TenantHeaderMode = "none" | "optional" | "tenant-scoped";

/** Which tenant, if any, a request acts for under the given credentials. */
export function resolveTenantHeader(
  credentials: ApiCredentials,
  mode: TenantHeaderMode,
): string | undefined {
  if (mode === "none") {
    return undefined;
  }

  if (mode === "optional") {
    return credentials.selectedTenantId ?? undefined;
  }

  if (credentials.authorityType === "tenant") {
    if (credentials.kind === "bearer") {
      return undefined;
    }
    return credentials.tenantId ?? undefined;
  }

  if (credentials.authorityType === "system_admin") {
    return credentials.selectedTenantId ?? undefined;
  }

  return undefined;
}

/** How a request authenticates, and which tenant it acts for. */
export type Authorization = {
  readonly credentials?: ApiCredentials;
  readonly bearerToken?: string;
  readonly tenantHeader?: TenantHeaderMode;
};

export const Authorization = {
  anonymous: {} as Authorization,
  webSession: { credentials: webSessionCredentials } as Authorization,
  of: (credentials: ApiCredentials): Authorization => ({ credentials }),
  tenantScoped: (credentials: ApiCredentials): Authorization => ({
    credentials,
    tenantHeader: "tenant-scoped",
  }),
};

/**
 * Authenticates API calls. Every request sent through `httpClient` inside `authorize`
 * carries that call's credentials and tenant, so callers never touch headers.
 */
export class ApiAuthorization extends Context.Service<
  ApiAuthorization,
  {
    /** The HttpClient API calls send their requests through. */
    readonly httpClient: HttpClient.HttpClient;
    /** Runs a call with the given authorization and maps its failures to ApiRequestError. */
    readonly authorize: (
      authorization: Authorization,
    ) => <A, R>(
      self: Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError, R>,
    ) => Effect.Effect<A, ApiRequestError, R>;
    /** Emits whenever the web session is found to be missing, expired or revoked. */
    readonly sessionAuthenticationFailures: Stream.Stream<void>;
  }
>()("@aperture/api-client/ApiAuthorization") {}
