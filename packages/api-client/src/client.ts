import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import * as Api from "@aperture/api-schema";
import { ApiRequestError, parseApiErrorBody } from "./errors.ts";
import type { ApiErrorBody } from "./errors.ts";
import {
  BrowserStatus,
  LoginMethods,
  PasskeyLoginOptions,
  PasskeyMutation,
  PasskeyRegistrationOptions,
  Passkeys,
  PasswordLoginResponse,
  RecoveryCodes,
  SecurityStatus,
  TOTPEnrollment,
} from "./schemas.ts";
import type { ResourceGrant, ResourceMode } from "./schemas.ts";

export const TENANT_HEADER = "X-Aperture-Tenant-Id";

export type ApiClientOptions = {
  baseUrl?: string;
};

export type TagFilterValue = Array<{
  key: string;
  operator: "eq" | "neq" | "in" | "not_in";
  values: string[];
}>;

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

const webSessionCredentials: ApiCredentials = {
  kind: "session",
  authorityType: null,
  tenantId: null,
  selectedTenantId: null,
};

export type TenantHeaderMode = "none" | "optional" | "tenant-scoped";

type Authorization = {
  credentials?: ApiCredentials | null;
  bearerToken?: string;
  tenantHeader?: TenantHeaderMode;
};

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

const sessionAuthenticationFailureCodes = new Set([
  "authentication_required",
  "invalid_authentication_token",
  "authentication_token_expired",
  "authentication_token_revoked",
  "user_disabled",
]);

export type SessionsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  status?: Api.SessionStatus;
  tags?: TagFilterValue;
};

export type SnapshotsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
  name?: string;
  tags?: TagFilterValue;
};

export type TenantsListParams = {
  limit?: number;
  cursor?: string;
  includeDeleted?: boolean;
  deleted?: "active" | "deleted" | "all";
};

export type UsersListParams = {
  limit?: number;
  cursor?: string;
  query?: string;
  disabled?: "active" | "disabled" | "all";
};

export type TokensListParams = {
  limit?: number;
  cursor?: string;
  tenantId?: string;
  name?: string;
  authorityType?: "system_admin" | "tenant";
  revoked?: "all" | "active" | "revoked";
  scope?: string;
};

export type EventsListParams = {
  limit?: number;
  cursor?: string;
  resourceType?: string;
  resourceId?: string;
};

export type InitialBrowserTarget = Api.InitialBrowserTarget;
export type InitialBrowserStorageState = Api.InitialBrowserStorageState;

export type CreateSessionInput = {
  baseSnapshotName?: string | null;
  label?: string | null;
  browser: {
    channel: string;
    args?: string[];
  };
  initialTargets?: readonly InitialBrowserTarget[];
  storageState?: InitialBrowserStorageState;
  tags?: Record<string, string>;
};

export interface CreateSessionOptions {
  waitForReady?: boolean;
}

export type PromoteSessionInput = {
  name: string;
  description?: string | null;
  force?: boolean;
  tags?: Record<string, string>;
};

export type UpdateSnapshotInput = {
  description: string | null;
};

export type CreateAdminTokenInput = {
  name: string;
  authorityType: "system_admin" | "tenant";
  tenantId?: string | null;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt?: string | null;
};

export type CreateTenantTokenInput = {
  name: string;
  scopes: string[];
  resourceMode: ResourceMode;
  resourceGrants: ResourceGrant[];
  expiresAt?: string | null;
};

export type UserInput = {
  email: string | null;
  displayName: string;
  isSystemAdmin: boolean;
};

export type DownloadedFile = {
  blob: Blob;
  filename: string | null;
};

type Query = Record<string, string | number | boolean | ReadonlyArray<string> | undefined | null>;

// Empty strings and empty list items mean "no filter", as they always have for callers.
function compactQuery<T extends Query>(query: T): T {
  const out: Query = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== "");
      if (items.length > 0) {
        out[key] = items;
      }
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

function tagQuery(tags: TagFilterValue | undefined) {
  return {
    tagKey: tags?.map((tag) => tag.key),
    tagOperator: tags?.map((tag) => tag.operator),
    tagValue: tags?.map((tag) => tag.values.join(",")),
  };
}

function contentDispositionFilename(header: string | undefined): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}

export const make = Effect.fnUntraced(function* (options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
  const httpClient = yield* HttpClient.HttpClient;
  const authenticationFailures = yield* PubSub.unbounded<void>();

  const authorize = ({ credentials = null, bearerToken, tenantHeader = "none" }: Authorization) =>
    HttpClient.mapRequest((request) => {
      let next = HttpClientRequest.acceptJson(HttpClientRequest.prependUrl(request, baseUrl));
      if (bearerToken) {
        next = HttpClientRequest.bearerToken(next, bearerToken);
      } else if (credentials?.kind === "bearer") {
        next = HttpClientRequest.bearerToken(next, credentials.token.trim());
      }
      const tenantId = credentials ? resolveTenantHeader(credentials, tenantHeader) : undefined;
      return tenantId
        ? HttpClientRequest.setHeader(next, TENANT_HEADER, tenantId)
        : HttpClientRequest.removeHeader(next, TENANT_HEADER);
    });

  const failWith = (
    authorization: Authorization,
    status: number,
    body: ApiErrorBody["error"] | null,
  ): Effect.Effect<never, ApiRequestError> => {
    if (!body) {
      return Effect.fail(
        new ApiRequestError({ code: "internal_error", message: "Request failed", status }),
      );
    }
    const notify =
      authorization.credentials?.kind === "session" &&
      sessionAuthenticationFailureCodes.has(body.code)
        ? PubSub.publish(authenticationFailures, undefined)
        : Effect.void;
    return notify.pipe(
      Effect.andThen(
        Effect.fail(new ApiRequestError({ code: body.code, message: body.message, status })),
      ),
    );
  };

  // Maps transport, status and decoding failures to ApiRequestError. `status` reports the
  // status of the response that failed to decode, if one arrived.
  const mapErrors =
    (authorization: Authorization, status: () => number) =>
    <A, R>(
      effect: Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError, R>,
    ): Effect.Effect<A, ApiRequestError, R> =>
      effect.pipe(
        Effect.catch((error) => {
          if (Schema.isSchemaError(error)) {
            return Effect.fail(
              new ApiRequestError({
                code: "internal_error",
                message: "Invalid response",
                status: status(),
              }),
            );
          }
          const reason = error.reason;
          if (reason._tag === "StatusCodeError") {
            return reason.response.json.pipe(
              Effect.orElseSucceed(() => null),
              Effect.flatMap((body) =>
                failWith(authorization, reason.response.status, parseApiErrorBody(body)),
              ),
            );
          }
          if (reason._tag === "DecodeError") {
            return Effect.fail(
              new ApiRequestError({
                code: "internal_error",
                message: "Invalid response",
                status: status(),
              }),
            );
          }
          return Effect.fail(
            new ApiRequestError({
              code: "network_error",
              message: "The server could not be reached",
              status: 0,
            }),
          );
        }),
      );

  // Runs one operation of the generated client with the given authorization.
  const api = <A>(
    authorization: Authorization,
    operation: (
      client: Api.ApertureApi,
    ) => Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError>,
  ): Effect.Effect<A, ApiRequestError> =>
    Effect.suspend(() => {
      let status = 0;
      const client = httpClient.pipe(
        authorize(authorization),
        HttpClient.tap((response) =>
          Effect.sync(() => {
            status = response.status;
          }),
        ),
      );
      return operation(Api.make(client)).pipe(mapErrors(authorization, () => status));
    });

  // Sends a request outside api/openapi.yaml and returns the successful response.
  const send = (
    authorization: Authorization,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiRequestError> =>
    httpClient
      .pipe(authorize(authorization), HttpClient.filterStatusOk)
      .execute(request)
      .pipe(mapErrors(authorization, () => 0));

  const sendJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
    authorization: Authorization,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], ApiRequestError> =>
    Effect.suspend(() => {
      let status = 0;
      return httpClient
        .pipe(authorize(authorization), HttpClient.filterStatusOk)
        .execute(request)
        .pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              status = response.status;
            }),
          ),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          mapErrors(authorization, () => status),
        );
    });

  const sendVoid = (
    authorization: Authorization,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<void, ApiRequestError> => Effect.asVoid(send(authorization, request));

  const post = (url: string, body?: unknown) =>
    body === undefined
      ? HttpClientRequest.post(url)
      : HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body);

  const session = { credentials: webSessionCredentials };
  const tenantScoped = (credentials: ApiCredentials): Authorization => ({
    credentials,
    tenantHeader: "tenant-scoped",
  });

  return {
    /** Emits whenever the web session is found to be missing, expired or revoked. */
    sessionAuthenticationFailures: Stream.fromPubSub(authenticationFailures),

    listLoginMethods: () =>
      sendJson({}, HttpClientRequest.get("/auth/login-methods"), LoginMethods),

    beginPasskeyLogin: () =>
      sendJson({}, post("/auth/passkeys/login/options"), PasskeyLoginOptions),

    finishPasskeyLogin: (credential: AuthenticationResponseJSON) =>
      sendVoid({}, post("/auth/passkeys/login/finish", credential)),

    listPasskeys: () => sendJson(session, HttpClientRequest.get("/auth/passkeys"), Passkeys),

    beginPasskeyRegistration: (name: string) =>
      sendJson(
        session,
        post("/auth/passkeys/registration/options", { name }),
        PasskeyRegistrationOptions,
      ),

    finishPasskeyRegistration: (credential: RegistrationResponseJSON) =>
      sendJson(session, post("/auth/passkeys/registration/finish", credential), PasskeyMutation),

    renamePasskey: (passkeyId: string, name: string) =>
      sendJson(
        session,
        HttpClientRequest.bodyJsonUnsafe(
          HttpClientRequest.patch(`/auth/passkeys/${encodeURIComponent(passkeyId)}`),
          { name },
        ),
        PasskeyMutation,
      ),

    deletePasskey: (passkeyId: string) =>
      sendVoid(
        session,
        HttpClientRequest.delete(`/auth/passkeys/${encodeURIComponent(passkeyId)}`),
      ),

    loginWithPassword: (email: string, password: string) =>
      sendJson({}, post("/auth/password/login", { email, password }), PasswordLoginResponse),

    loginWithAPIToken: (token: string) => sendVoid({}, post("/auth/token/login", { token })),

    completePasswordMFA: (code: string) => sendVoid({}, post("/auth/password/login/mfa", { code })),

    getSecurityStatus: () =>
      sendJson(session, HttpClientRequest.get("/auth/security"), SecurityStatus),

    setPassword: (currentPassword: string, newPassword: string) =>
      sendVoid(
        session,
        HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put("/auth/password"), {
          currentPassword,
          newPassword,
        }),
      ),

    acceptUserInvitation: (token: string, password: string) =>
      sendVoid({}, post("/auth/invitations/accept", { token, password })),

    beginTOTPEnrollment: () =>
      sendJson(session, post("/auth/totp/enrollment/options"), TOTPEnrollment),

    completeTOTPEnrollment: (code: string) =>
      sendJson(session, post("/auth/totp/enrollment/finish", { code }), RecoveryCodes),

    regenerateRecoveryCodes: (code: string) =>
      sendJson(session, post("/auth/totp/recovery-codes", { code }), RecoveryCodes),

    disableTOTP: (code: string) => sendVoid(session, post("/auth/totp/disable", { code })),

    logoutWebSession: () => sendVoid(session, post("/auth/logout")),

    getHealth: () => api({}, (client) => client.getHealth(undefined)),

    getAuthMe: (
      selectedTenantId: string | null = null,
      credentials: ApiCredentials = webSessionCredentials,
    ) =>
      api(
        { credentials: { ...credentials, selectedTenantId }, tenantHeader: "optional" },
        (client) => client.getCurrentPrincipal(undefined),
      ),

    getBrowserChannels: (credentials: ApiCredentials) =>
      api(tenantScoped(credentials), (client) => client.listBrowserChannels(undefined)),

    getBrowserStatus: (credentials: ApiCredentials, sessionId: string, sessionToken?: string) =>
      sendJson(
        { credentials, bearerToken: sessionToken },
        HttpClientRequest.get(`/sessions/${encodeURIComponent(sessionId)}/browser/status`),
        BrowserStatus,
      ),

    listTenants: (credentials: ApiCredentials, params: TenantsListParams = {}) =>
      api({ credentials }, (client) =>
        client.listTenants({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            includeDeleted: params.includeDeleted || undefined,
            deleted: params.deleted,
          }),
        }),
      ),

    createTenant: (credentials: ApiCredentials, input: { displayName: string }) =>
      api({ credentials }, (client) => client.createTenant({ payload: input })),

    updateTenant: (credentials: ApiCredentials, tenantId: string, input: { displayName: string }) =>
      api({ credentials }, (client) => client.updateTenant(tenantId, { payload: input })),

    deleteTenant: (credentials: ApiCredentials, tenantId: string) =>
      api({ credentials }, (client) => client.deleteTenant(tenantId, undefined)),

    restoreTenant: (credentials: ApiCredentials, tenantId: string) =>
      api({ credentials }, (client) => client.restoreTenant(tenantId, undefined)),

    listUsers: (credentials: ApiCredentials, params: UsersListParams = {}) =>
      api({ credentials }, (client) =>
        client.listUsers({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            query: params.query,
            disabled: params.disabled,
          }),
        }),
      ),

    createUser: (credentials: ApiCredentials, input: UserInput) =>
      api({ credentials }, (client) => client.createUser({ payload: input })),

    getUser: (credentials: ApiCredentials, userId: string) =>
      api({ credentials }, (client) => client.getUser(userId, undefined)),

    updateUser: (credentials: ApiCredentials, userId: string, input: UserInput) =>
      api({ credentials }, (client) => client.updateUser(userId, { payload: input })),

    createUserInvitation: (credentials: ApiCredentials, userId: string) =>
      api({ credentials }, (client) => client.createUserInvitation(userId, undefined)),

    disableUser: (credentials: ApiCredentials, userId: string) =>
      api({ credentials }, (client) => client.disableUser(userId, undefined)),

    restoreUser: (credentials: ApiCredentials, userId: string) =>
      api({ credentials }, (client) => client.restoreUser(userId, undefined)),

    listUserMemberships: (credentials: ApiCredentials, userId: string) =>
      api({ credentials }, (client) => client.listUserMemberships(userId, undefined)),

    upsertTenantMembership: (
      credentials: ApiCredentials,
      tenantId: string,
      userId: string,
      scopes: readonly string[],
    ) =>
      api({ credentials }, (client) =>
        client.upsertTenantMembership(tenantId, userId, {
          payload: { scopes } as typeof Api.UpsertTenantMembershipRequestJson.Encoded,
        }),
      ),

    deleteTenantMembership: (credentials: ApiCredentials, tenantId: string, userId: string) =>
      Effect.asVoid(
        api({ credentials }, (client) =>
          client.deleteTenantMembership(tenantId, userId, undefined),
        ),
      ),

    listSessions: (credentials: ApiCredentials, params: SessionsListParams = {}) =>
      api(tenantScoped(credentials), (client) =>
        client.listSessions({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            includeDeleted: params.includeDeleted || undefined,
            status: params.status,
            ...tagQuery(params.tags),
          }),
        }),
      ),

    getSession: (credentials: ApiCredentials, sessionId: string) =>
      api(tenantScoped(credentials), (client) => client.getSession(sessionId, undefined)),

    getSessionsBulk: (credentials: ApiCredentials, sessionIds: readonly string[]) =>
      api(tenantScoped(credentials), (client) =>
        client.getSessionsBulk({ payload: { ids: sessionIds } }),
      ),

    createSession: (
      credentials: ApiCredentials,
      input: CreateSessionInput,
      options: CreateSessionOptions = {},
    ) =>
      api(tenantScoped(credentials), (client) =>
        client.createSession({
          params: compactQuery({ waitForReady: options.waitForReady }),
          payload: {
            baseSnapshotName: input.baseSnapshotName ?? null,
            label: input.label ?? null,
            browser: {
              channel: input.browser.channel,
              args: input.browser.args ?? [],
            },
            initialTargets: input.initialTargets ?? [],
            ...(input.storageState === undefined ? {} : { storageState: input.storageState }),
            tags: input.tags ?? {},
          },
        }),
      ),

    deleteSession: (credentials: ApiCredentials, sessionId: string) =>
      api(tenantScoped(credentials), (client) => client.deleteSession(sessionId, undefined)),

    reopenSession: (credentials: ApiCredentials, sessionId: string) =>
      api(tenantScoped(credentials), (client) => client.reopenSession(sessionId, undefined)),

    suspendSession: (credentials: ApiCredentials, sessionId: string) =>
      api(tenantScoped(credentials), (client) => client.suspendSession(sessionId, undefined)),

    rotateSessionToken: (credentials: ApiCredentials, sessionId: string) =>
      api(tenantScoped(credentials), (client) => client.rotateSessionToken(sessionId, undefined)),

    rotateCollaborationCapability: (
      credentials: ApiCredentials,
      sessionId: string,
      role: "editor" | "viewer",
    ) =>
      api(tenantScoped(credentials), (client) =>
        client.rotateCollaborationCapability(sessionId, role, undefined),
      ),

    promoteSession: (credentials: ApiCredentials, sessionId: string, input: PromoteSessionInput) =>
      api(tenantScoped(credentials), (client) =>
        client.promoteSession(sessionId, {
          payload: {
            name: input.name,
            description: input.description ?? null,
            force: input.force ?? false,
            tags: input.tags ?? {},
          },
        }),
      ),

    replaceSessionTags: (
      credentials: ApiCredentials,
      sessionId: string,
      tags: Record<string, string>,
    ) =>
      api(tenantScoped(credentials), (client) =>
        client.replaceSessionTags(sessionId, { payload: { tags } }),
      ),

    downloadSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
      sessionToken?: string,
    ): Effect.Effect<DownloadedFile, ApiRequestError> => {
      const authorization: Authorization = {
        credentials,
        bearerToken: sessionToken,
        tenantHeader: "tenant-scoped",
      };
      return send(
        authorization,
        HttpClientRequest.get(
          `/sessions/${encodeURIComponent(sessionId)}/recordings/${encodeURIComponent(recordingId)}/content`,
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.arrayBuffer.pipe(
            Effect.map((body) => ({
              blob: new Blob([body], { type: response.headers["content-type"] ?? "" }),
              filename: contentDispositionFilename(response.headers["content-disposition"]),
            })),
            mapErrors(authorization, () => response.status),
          ),
        ),
      );
    },

    listSnapshots: (credentials: ApiCredentials, params: SnapshotsListParams = {}) =>
      api(tenantScoped(credentials), (client) =>
        client.listSnapshots({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            includeDeleted: params.includeDeleted || undefined,
            deleted: params.deleted,
            name: params.name,
            ...tagQuery(params.tags),
          }),
        }),
      ),

    deleteSnapshot: (credentials: ApiCredentials, name: string) =>
      api(tenantScoped(credentials), (client) => client.deleteSnapshot(name, undefined)),

    restoreSnapshot: (credentials: ApiCredentials, name: string) =>
      api(tenantScoped(credentials), (client) => client.restoreSnapshot(name, undefined)),

    replaceSnapshotTags: (
      credentials: ApiCredentials,
      name: string,
      tags: Record<string, string>,
    ) =>
      api(tenantScoped(credentials), (client) =>
        client.replaceSnapshotTags(name, { payload: { tags } }),
      ),

    updateSnapshot: (credentials: ApiCredentials, name: string, input: UpdateSnapshotInput) =>
      api(tenantScoped(credentials), (client) => client.updateSnapshot(name, { payload: input })),

    listEvents: (credentials: ApiCredentials, params: EventsListParams = {}) =>
      api(tenantScoped(credentials), (client) =>
        client.listEvents({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            resourceType: params.resourceType,
            resourceId: params.resourceId,
          }),
        }),
      ),

    listAdminTokens: (credentials: ApiCredentials, params: TokensListParams = {}) =>
      api({ credentials }, (client) =>
        client.listAdminTokens({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            tenantId: params.tenantId,
            name: params.name,
            authorityType: params.authorityType,
            revoked: params.revoked,
            scope: params.scope,
          }) as typeof Api.ListAdminTokensParams.Encoded,
        }),
      ),

    listTenantTokens: (credentials: ApiCredentials, params: TokensListParams = {}) =>
      api({ credentials }, (client) =>
        client.listTenantTokens({
          params: compactQuery({
            limit: params.limit,
            cursor: params.cursor,
            name: params.name,
            revoked: params.revoked,
            scope: params.scope,
          }) as typeof Api.ListTenantTokensParams.Encoded,
        }),
      ),

    // Scopes arrive from free-form UI state; the server validates them.
    createAdminToken: (credentials: ApiCredentials, input: CreateAdminTokenInput) =>
      api({ credentials }, (client) =>
        client.createAdminToken({
          payload: {
            name: input.name,
            authorityType: input.authorityType,
            tenantId: input.tenantId ?? null,
            scopes: input.scopes,
            resourceMode: input.authorityType === "system_admin" ? "all" : input.resourceMode,
            resourceGrants: input.authorityType === "system_admin" ? [] : input.resourceGrants,
            expiresAt: input.expiresAt ?? null,
          } as typeof Api.CreateAdminTokenRequestJson.Encoded,
        }),
      ),

    createTenantToken: (credentials: ApiCredentials, input: CreateTenantTokenInput) =>
      api({ credentials }, (client) =>
        client.createTenantToken({
          payload: {
            name: input.name,
            scopes: input.scopes,
            resourceMode: input.resourceMode,
            resourceGrants: input.resourceGrants,
            expiresAt: input.expiresAt ?? null,
          } as typeof Api.CreateTenantTokenRequestJson.Encoded,
        }),
      ),

    revokeAdminToken: (credentials: ApiCredentials, tokenId: string) =>
      Effect.asVoid(api({ credentials }, (client) => client.revokeAdminToken(tokenId, undefined))),

    revokeTenantToken: (credentials: ApiCredentials, tokenId: string) =>
      Effect.asVoid(api({ credentials }, (client) => client.revokeTenantToken(tokenId, undefined))),
  };
});

export class ApiClient extends Context.Service<
  ApiClient,
  Effect.Success<ReturnType<typeof make>>
>()("@aperture/api-client/ApiClient") {
  static readonly layer = (options: ApiClientOptions = {}) =>
    Layer.effect(ApiClient, make(options));
}
