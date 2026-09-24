import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { identity } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import * as Api from "@aperture/api-schema";
import { ApiRequestError, parseApiErrorBody } from "./errors.ts";
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
import type * as S from "./schemas.ts";
import {
  resolveTenantHeader,
  TENANT_HEADER,
  webSessionCredentials,
  type ApiCredentials,
  type CreateAdminTokenInput,
  type CreateSessionInput,
  type CreateSessionOptions,
  type CreateTenantTokenInput,
  type DownloadedFile,
  type EventsListParams,
  type PromoteSessionInput,
  type SessionsListParams,
  type SnapshotsListParams,
  type TagFilterValue,
  type TenantHeaderMode,
  type TenantsListParams,
  type TokensListParams,
  type UpdateSnapshotInput,
  type UserInput,
  type UsersListParams,
} from "./types.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

export class ApiClient extends Context.Service<
  ApiClient,
  {
    /** Emits whenever the web session is found to be missing, expired or revoked. */
    readonly sessionAuthenticationFailures: Stream.Stream<void>;

    readonly listLoginMethods: () => Call<S.LoginMethods>;
    readonly beginPasskeyLogin: () => Call<S.PasskeyLoginOptions>;
    readonly finishPasskeyLogin: (credential: AuthenticationResponseJSON) => Call<void>;
    readonly listPasskeys: () => Call<S.Passkeys>;
    readonly beginPasskeyRegistration: (name: string) => Call<S.PasskeyRegistrationOptions>;
    readonly finishPasskeyRegistration: (
      credential: RegistrationResponseJSON,
    ) => Call<S.PasskeyMutation>;
    readonly renamePasskey: (passkeyId: string, name: string) => Call<S.PasskeyMutation>;
    readonly deletePasskey: (passkeyId: string) => Call<void>;
    readonly loginWithPassword: (email: string, password: string) => Call<S.PasswordLoginResponse>;
    readonly loginWithAPIToken: (token: string) => Call<void>;
    readonly completePasswordMFA: (code: string) => Call<void>;
    readonly getSecurityStatus: () => Call<S.SecurityStatus>;
    readonly setPassword: (currentPassword: string, newPassword: string) => Call<void>;
    readonly acceptUserInvitation: (token: string, password: string) => Call<void>;
    readonly beginTOTPEnrollment: () => Call<S.TOTPEnrollment>;
    readonly completeTOTPEnrollment: (code: string) => Call<S.RecoveryCodes>;
    readonly regenerateRecoveryCodes: (code: string) => Call<S.RecoveryCodes>;
    readonly disableTOTP: (code: string) => Call<void>;
    readonly logoutWebSession: () => Call<void>;

    readonly getHealth: () => Call<S.Health>;
    readonly getAuthMe: (
      selectedTenantId?: string | null,
      credentials?: ApiCredentials,
    ) => Call<S.AuthMeResponse>;
    readonly getBrowserChannels: (credentials: ApiCredentials) => Call<S.BrowserChannelsResponse>;
    readonly getBrowserStatus: (
      credentials: ApiCredentials,
      sessionId: string,
      sessionToken?: string,
    ) => Call<S.BrowserStatus>;

    readonly listTenants: (
      credentials: ApiCredentials,
      params?: TenantsListParams,
    ) => Call<S.TenantsPage>;
    readonly createTenant: (credentials: ApiCredentials, input: Api.TenantInput) => Call<S.Tenant>;
    readonly updateTenant: (
      credentials: ApiCredentials,
      tenantId: string,
      input: Api.TenantInput,
    ) => Call<S.Tenant>;
    readonly deleteTenant: (credentials: ApiCredentials, tenantId: string) => Call<S.Tenant>;
    readonly restoreTenant: (credentials: ApiCredentials, tenantId: string) => Call<S.Tenant>;

    readonly listUsers: (
      credentials: ApiCredentials,
      params?: UsersListParams,
    ) => Call<S.UsersPage>;
    readonly createUser: (credentials: ApiCredentials, input: UserInput) => Call<S.User>;
    readonly getUser: (credentials: ApiCredentials, userId: string) => Call<S.User>;
    readonly updateUser: (
      credentials: ApiCredentials,
      userId: string,
      input: UserInput,
    ) => Call<S.User>;
    readonly createUserInvitation: (
      credentials: ApiCredentials,
      userId: string,
    ) => Call<S.UserInvitation>;
    readonly disableUser: (credentials: ApiCredentials, userId: string) => Call<S.User>;
    readonly restoreUser: (credentials: ApiCredentials, userId: string) => Call<S.User>;
    readonly listUserMemberships: (
      credentials: ApiCredentials,
      userId: string,
    ) => Call<ReadonlyArray<S.TenantMembership>>;
    readonly upsertTenantMembership: (
      credentials: ApiCredentials,
      tenantId: string,
      userId: string,
      scopes: readonly string[],
    ) => Call<S.TenantMembership>;
    readonly deleteTenantMembership: (
      credentials: ApiCredentials,
      tenantId: string,
      userId: string,
    ) => Call<void>;

    readonly listSessions: (
      credentials: ApiCredentials,
      params?: SessionsListParams,
    ) => Call<S.SessionsPage>;
    readonly getSession: (credentials: ApiCredentials, sessionId: string) => Call<S.Session>;
    readonly getSessionsBulk: (
      credentials: ApiCredentials,
      sessionIds: readonly string[],
    ) => Call<S.SessionsBulkResponse>;
    readonly createSession: (
      credentials: ApiCredentials,
      input: CreateSessionInput,
      options?: CreateSessionOptions,
    ) => Call<S.CreateSessionResponse>;
    readonly deleteSession: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<S.SessionMutationResponse>;
    readonly reopenSession: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<S.SessionMutationResponse>;
    readonly suspendSession: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<S.SessionMutationResponse>;
    readonly rotateSessionToken: (
      credentials: ApiCredentials,
      sessionId: string,
    ) => Call<S.SessionMutationResponse>;
    readonly rotateCollaborationCapability: (
      credentials: ApiCredentials,
      sessionId: string,
      role: "editor" | "viewer",
    ) => Call<S.SessionMutationResponse>;
    readonly promoteSession: (
      credentials: ApiCredentials,
      sessionId: string,
      input: PromoteSessionInput,
    ) => Call<S.PromoteSessionResponse>;
    readonly replaceSessionTags: (
      credentials: ApiCredentials,
      sessionId: string,
      tags: Record<string, string>,
    ) => Call<S.SessionMutationResponse>;
    readonly downloadSessionRecording: (
      credentials: ApiCredentials,
      sessionId: string,
      recordingId: string,
      sessionToken?: string,
    ) => Call<DownloadedFile>;

    readonly listSnapshots: (
      credentials: ApiCredentials,
      params?: SnapshotsListParams,
    ) => Call<S.SnapshotsPage>;
    readonly deleteSnapshot: (
      credentials: ApiCredentials,
      name: string,
    ) => Call<S.SnapshotMutationResponse>;
    readonly restoreSnapshot: (
      credentials: ApiCredentials,
      name: string,
    ) => Call<S.SnapshotMutationResponse>;
    readonly replaceSnapshotTags: (
      credentials: ApiCredentials,
      name: string,
      tags: Record<string, string>,
    ) => Call<S.SnapshotMutationResponse>;
    readonly updateSnapshot: (
      credentials: ApiCredentials,
      name: string,
      input: UpdateSnapshotInput,
    ) => Call<S.SnapshotMutationResponse>;

    readonly listEvents: (
      credentials: ApiCredentials,
      params?: EventsListParams,
    ) => Call<S.EventsPage>;

    readonly listAdminTokens: (
      credentials: ApiCredentials,
      params?: TokensListParams,
    ) => Call<S.TokensPage>;
    readonly listTenantTokens: (
      credentials: ApiCredentials,
      params?: TokensListParams,
    ) => Call<S.TokensPage>;
    readonly createAdminToken: (
      credentials: ApiCredentials,
      input: CreateAdminTokenInput,
    ) => Call<S.CreateTokenResponse>;
    readonly createTenantToken: (
      credentials: ApiCredentials,
      input: CreateTenantTokenInput,
    ) => Call<S.CreateTokenResponse>;
    readonly revokeAdminToken: (credentials: ApiCredentials, tokenId: string) => Call<void>;
    readonly revokeTenantToken: (credentials: ApiCredentials, tokenId: string) => Call<void>;
  }
>()("@aperture/api-client/ApiClient") {}

/** How a request authenticates, and which tenant it acts for. */
type Authorization = {
  readonly credentials?: ApiCredentials;
  readonly bearerToken?: string;
  readonly tenantHeader?: TenantHeaderMode;
};

/** The authorization of the request being sent; set per call by `authorized`. */
const RequestAuthorization = Context.Reference<Authorization>(
  "@aperture/api-client/RequestAuthorization",
  { defaultValue: () => ({}) },
);

const anonymous: Authorization = {};
const webSession: Authorization = { credentials: webSessionCredentials };
const tenantScoped = (credentials: ApiCredentials): Authorization => ({
  credentials,
  tenantHeader: "tenant-scoped",
});

const authorizeRequest = (request: HttpClientRequest.HttpClientRequest) =>
  RequestAuthorization.useSync(({ credentials, bearerToken, tenantHeader = "none" }) => {
    const token =
      bearerToken ?? (credentials?.kind === "bearer" ? credentials.token.trim() : undefined);
    const tenantId = credentials ? resolveTenantHeader(credentials, tenantHeader) : undefined;
    return request.pipe(
      HttpClientRequest.acceptJson,
      token ? HttpClientRequest.bearerToken(token) : identity,
      tenantId
        ? HttpClientRequest.setHeader(TENANT_HEADER, tenantId)
        : HttpClientRequest.removeHeader(TENANT_HEADER),
    );
  });

const sessionAuthenticationFailureCodes = new Set([
  "authentication_required",
  "invalid_authentication_token",
  "authentication_token_expired",
  "authentication_token_revoked",
  "user_disabled",
]);

const invalidResponse = (status: number) =>
  new ApiRequestError({ code: "internal_error", message: "Invalid response", status });

// Status failures carry the server's error body; everything else maps to a generic code.
const toApiRequestError = (
  error: HttpClientError.HttpClientError | Schema.SchemaError,
): Effect.Effect<never, ApiRequestError> => {
  if (Schema.isSchemaError(error)) return Effect.fail(invalidResponse(0));
  const { reason } = error;
  switch (reason._tag) {
    case "StatusCodeError":
      return reason.response.json.pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((body) => {
          const detail = parseApiErrorBody(body);
          return Effect.fail(
            new ApiRequestError({
              code: detail?.code ?? "internal_error",
              message: detail?.message ?? "Request failed",
              status: reason.response.status,
            }),
          );
        }),
      );
    case "DecodeError":
      return Effect.fail(invalidResponse(reason.response.status));
    default:
      return Effect.fail(
        new ApiRequestError({
          code: "network_error",
          message: "The server could not be reached",
          status: 0,
        }),
      );
  }
};

const tagQuery = (tags: TagFilterValue | undefined) => ({
  tagKey: tags?.map((tag) => tag.key),
  tagOperator: tags?.map((tag) => tag.operator),
  tagValue: tags?.map((tag) => tag.values.join(",")),
});

// Empty strings and empty list items mean "no filter", as they always have for callers.
const compactQuery = <T extends object>(query: T): T =>
  Object.fromEntries(
    Object.entries(query).flatMap(([key, value]) => {
      if (value === undefined || value === null || value === "") return [];
      if (!Array.isArray(value)) return [[key, value]];
      const items = value.filter((item) => item !== "");
      return items.length > 0 ? [[key, items]] : [];
    }),
  ) as T;

const jsonBody = (body: unknown) => ({ body: HttpBody.jsonUnsafe(body) });

const contentDispositionFilename = (header: string | undefined): string | null =>
  header?.match(/filename="([^"]+)"/)?.[1] ?? null;

export const makeApiClient = Effect.gen(function* () {
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequestEffect(authorizeRequest),
  );
  const httpClientOk = HttpClient.filterStatusOk(httpClient);
  const api = Api.make(httpClient);
  const authenticationFailures = yield* PubSub.unbounded<void>();

  /** Sends a call with the given authorization and maps its failures to ApiRequestError. */
  const authorized =
    (authorization: Authorization) =>
    <A>(self: Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError>): Call<A> =>
      self.pipe(
        Effect.catch(toApiRequestError),
        Effect.tapError((error) =>
          authorization.credentials?.kind === "session" &&
          sessionAuthenticationFailureCodes.has(error.code)
            ? PubSub.publish(authenticationFailures, undefined)
            : Effect.void,
        ),
        Effect.provideService(RequestAuthorization, authorization),
      );

  // Login flows and live session resources outside api/openapi.yaml.

  const listLoginMethods = Effect.fn("ApiClient.listLoginMethods")(function* () {
    return yield* httpClientOk
      .get("/auth/login-methods")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(LoginMethods)), authorized(anonymous));
  });

  const beginPasskeyLogin = Effect.fn("ApiClient.beginPasskeyLogin")(function* () {
    return yield* httpClientOk
      .post("/auth/passkeys/login/options")
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyLoginOptions)),
        authorized(anonymous),
      );
  });

  const finishPasskeyLogin = Effect.fn("ApiClient.finishPasskeyLogin")(function* (
    credential: AuthenticationResponseJSON,
  ) {
    yield* httpClientOk
      .post("/auth/passkeys/login/finish", jsonBody(credential))
      .pipe(authorized(anonymous));
  });

  const listPasskeys = Effect.fn("ApiClient.listPasskeys")(function* () {
    return yield* httpClientOk
      .get("/auth/passkeys")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Passkeys)), authorized(webSession));
  });

  const beginPasskeyRegistration = Effect.fn("ApiClient.beginPasskeyRegistration")(function* (
    name: string,
  ) {
    return yield* httpClientOk
      .post("/auth/passkeys/registration/options", jsonBody({ name }))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyRegistrationOptions)),
        authorized(webSession),
      );
  });

  const finishPasskeyRegistration = Effect.fn("ApiClient.finishPasskeyRegistration")(function* (
    credential: RegistrationResponseJSON,
  ) {
    return yield* httpClientOk
      .post("/auth/passkeys/registration/finish", jsonBody(credential))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyMutation)),
        authorized(webSession),
      );
  });

  const renamePasskey = Effect.fn("ApiClient.renamePasskey")(function* (
    passkeyId: string,
    name: string,
  ) {
    return yield* httpClientOk
      .patch(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, jsonBody({ name }))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyMutation)),
        authorized(webSession),
      );
  });

  const deletePasskey = Effect.fn("ApiClient.deletePasskey")(function* (passkeyId: string) {
    yield* httpClientOk
      .del(`/auth/passkeys/${encodeURIComponent(passkeyId)}`)
      .pipe(authorized(webSession));
  });

  const loginWithPassword = Effect.fn("ApiClient.loginWithPassword")(function* (
    email: string,
    password: string,
  ) {
    return yield* httpClientOk
      .post("/auth/password/login", jsonBody({ email, password }))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PasswordLoginResponse)),
        authorized(anonymous),
      );
  });

  const loginWithAPIToken = Effect.fn("ApiClient.loginWithAPIToken")(function* (token: string) {
    yield* httpClientOk.post("/auth/token/login", jsonBody({ token })).pipe(authorized(anonymous));
  });

  const completePasswordMFA = Effect.fn("ApiClient.completePasswordMFA")(function* (code: string) {
    yield* httpClientOk
      .post("/auth/password/login/mfa", jsonBody({ code }))
      .pipe(authorized(anonymous));
  });

  const getSecurityStatus = Effect.fn("ApiClient.getSecurityStatus")(function* () {
    return yield* httpClientOk
      .get("/auth/security")
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SecurityStatus)),
        authorized(webSession),
      );
  });

  const setPassword = Effect.fn("ApiClient.setPassword")(function* (
    currentPassword: string,
    newPassword: string,
  ) {
    yield* httpClientOk
      .put("/auth/password", jsonBody({ currentPassword, newPassword }))
      .pipe(authorized(webSession));
  });

  const acceptUserInvitation = Effect.fn("ApiClient.acceptUserInvitation")(function* (
    token: string,
    password: string,
  ) {
    yield* httpClientOk
      .post("/auth/invitations/accept", jsonBody({ token, password }))
      .pipe(authorized(anonymous));
  });

  const beginTOTPEnrollment = Effect.fn("ApiClient.beginTOTPEnrollment")(function* () {
    return yield* httpClientOk
      .post("/auth/totp/enrollment/options")
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TOTPEnrollment)),
        authorized(webSession),
      );
  });

  const completeTOTPEnrollment = Effect.fn("ApiClient.completeTOTPEnrollment")(function* (
    code: string,
  ) {
    return yield* httpClientOk
      .post("/auth/totp/enrollment/finish", jsonBody({ code }))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RecoveryCodes)),
        authorized(webSession),
      );
  });

  const regenerateRecoveryCodes = Effect.fn("ApiClient.regenerateRecoveryCodes")(function* (
    code: string,
  ) {
    return yield* httpClientOk
      .post("/auth/totp/recovery-codes", jsonBody({ code }))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RecoveryCodes)),
        authorized(webSession),
      );
  });

  const disableTOTP = Effect.fn("ApiClient.disableTOTP")(function* (code: string) {
    yield* httpClientOk.post("/auth/totp/disable", jsonBody({ code })).pipe(authorized(webSession));
  });

  const logoutWebSession = Effect.fn("ApiClient.logoutWebSession")(function* () {
    yield* httpClientOk.post("/auth/logout").pipe(authorized(webSession));
  });

  const getBrowserStatus = Effect.fn("ApiClient.getBrowserStatus")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    sessionToken?: string,
  ) {
    return yield* httpClientOk
      .get(`/sessions/${encodeURIComponent(sessionId)}/browser/status`)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(BrowserStatus)),
        authorized({ credentials, bearerToken: sessionToken }),
      );
  });

  const downloadSessionRecording = Effect.fn("ApiClient.downloadSessionRecording")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    recordingId: string,
    sessionToken?: string,
  ) {
    return yield* httpClientOk
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
        authorized({ credentials, bearerToken: sessionToken, tenantHeader: "tenant-scoped" }),
      );
  });

  // Resources in api/openapi.yaml, through the generated client.

  const getHealth = Effect.fn("ApiClient.getHealth")(function* () {
    return yield* api.getHealth(undefined).pipe(authorized(anonymous));
  });

  const getAuthMe = Effect.fn("ApiClient.getAuthMe")(function* (
    selectedTenantId: string | null = null,
    credentials: ApiCredentials = webSessionCredentials,
  ) {
    return yield* api
      .getCurrentPrincipal(undefined)
      .pipe(
        authorized({ credentials: { ...credentials, selectedTenantId }, tenantHeader: "optional" }),
      );
  });

  const getBrowserChannels = Effect.fn("ApiClient.getBrowserChannels")(function* (
    credentials: ApiCredentials,
  ) {
    return yield* api.listBrowserChannels(undefined).pipe(authorized(tenantScoped(credentials)));
  });

  const listTenants = Effect.fn("ApiClient.listTenants")(function* (
    credentials: ApiCredentials,
    params: TenantsListParams = {},
  ) {
    return yield* api
      .listTenants({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          includeDeleted: params.includeDeleted || undefined,
          deleted: params.deleted,
        }),
      })
      .pipe(authorized({ credentials }));
  });

  const createTenant = Effect.fn("ApiClient.createTenant")(function* (
    credentials: ApiCredentials,
    input: Api.TenantInput,
  ) {
    return yield* api.createTenant({ payload: input }).pipe(authorized({ credentials }));
  });

  const updateTenant = Effect.fn("ApiClient.updateTenant")(function* (
    credentials: ApiCredentials,
    tenantId: string,
    input: Api.TenantInput,
  ) {
    return yield* api.updateTenant(tenantId, { payload: input }).pipe(authorized({ credentials }));
  });

  const deleteTenant = Effect.fn("ApiClient.deleteTenant")(function* (
    credentials: ApiCredentials,
    tenantId: string,
  ) {
    return yield* api.deleteTenant(tenantId, undefined).pipe(authorized({ credentials }));
  });

  const restoreTenant = Effect.fn("ApiClient.restoreTenant")(function* (
    credentials: ApiCredentials,
    tenantId: string,
  ) {
    return yield* api.restoreTenant(tenantId, undefined).pipe(authorized({ credentials }));
  });

  const listUsers = Effect.fn("ApiClient.listUsers")(function* (
    credentials: ApiCredentials,
    params: UsersListParams = {},
  ) {
    return yield* api
      .listUsers({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          query: params.query,
          disabled: params.disabled,
        }),
      })
      .pipe(authorized({ credentials }));
  });

  const createUser = Effect.fn("ApiClient.createUser")(function* (
    credentials: ApiCredentials,
    input: UserInput,
  ) {
    return yield* api.createUser({ payload: input }).pipe(authorized({ credentials }));
  });

  const getUser = Effect.fn("ApiClient.getUser")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.getUser(userId, undefined).pipe(authorized({ credentials }));
  });

  const updateUser = Effect.fn("ApiClient.updateUser")(function* (
    credentials: ApiCredentials,
    userId: string,
    input: UserInput,
  ) {
    return yield* api.updateUser(userId, { payload: input }).pipe(authorized({ credentials }));
  });

  const createUserInvitation = Effect.fn("ApiClient.createUserInvitation")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.createUserInvitation(userId, undefined).pipe(authorized({ credentials }));
  });

  const disableUser = Effect.fn("ApiClient.disableUser")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.disableUser(userId, undefined).pipe(authorized({ credentials }));
  });

  const restoreUser = Effect.fn("ApiClient.restoreUser")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.restoreUser(userId, undefined).pipe(authorized({ credentials }));
  });

  const listUserMemberships = Effect.fn("ApiClient.listUserMemberships")(function* (
    credentials: ApiCredentials,
    userId: string,
  ) {
    return yield* api.listUserMemberships(userId, undefined).pipe(authorized({ credentials }));
  });

  const upsertTenantMembership = Effect.fn("ApiClient.upsertTenantMembership")(function* (
    credentials: ApiCredentials,
    tenantId: string,
    userId: string,
    scopes: readonly string[],
  ) {
    // Scopes arrive from free-form UI state; the server validates them.
    const payload = { scopes } as typeof Api.UpsertTenantMembershipRequestJson.Encoded;
    return yield* api
      .upsertTenantMembership(tenantId, userId, { payload })
      .pipe(authorized({ credentials }));
  });

  const deleteTenantMembership = Effect.fn("ApiClient.deleteTenantMembership")(function* (
    credentials: ApiCredentials,
    tenantId: string,
    userId: string,
  ) {
    yield* api
      .deleteTenantMembership(tenantId, userId, undefined)
      .pipe(authorized({ credentials }));
  });

  const listSessions = Effect.fn("ApiClient.listSessions")(function* (
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
      .pipe(authorized(tenantScoped(credentials)));
  });

  const getSession = Effect.fn("ApiClient.getSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api.getSession(sessionId, undefined).pipe(authorized(tenantScoped(credentials)));
  });

  const getSessionsBulk = Effect.fn("ApiClient.getSessionsBulk")(function* (
    credentials: ApiCredentials,
    sessionIds: readonly string[],
  ) {
    return yield* api
      .getSessionsBulk({ payload: { ids: sessionIds } })
      .pipe(authorized(tenantScoped(credentials)));
  });

  const createSession = Effect.fn("ApiClient.createSession")(function* (
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
      .pipe(authorized(tenantScoped(credentials)));
  });

  const deleteSession = Effect.fn("ApiClient.deleteSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api
      .deleteSession(sessionId, undefined)
      .pipe(authorized(tenantScoped(credentials)));
  });

  const reopenSession = Effect.fn("ApiClient.reopenSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api
      .reopenSession(sessionId, undefined)
      .pipe(authorized(tenantScoped(credentials)));
  });

  const suspendSession = Effect.fn("ApiClient.suspendSession")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api
      .suspendSession(sessionId, undefined)
      .pipe(authorized(tenantScoped(credentials)));
  });

  const rotateSessionToken = Effect.fn("ApiClient.rotateSessionToken")(function* (
    credentials: ApiCredentials,
    sessionId: string,
  ) {
    return yield* api
      .rotateSessionToken(sessionId, undefined)
      .pipe(authorized(tenantScoped(credentials)));
  });

  const rotateCollaborationCapability = Effect.fn("ApiClient.rotateCollaborationCapability")(
    function* (credentials: ApiCredentials, sessionId: string, role: "editor" | "viewer") {
      return yield* api
        .rotateCollaborationCapability(sessionId, role, undefined)
        .pipe(authorized(tenantScoped(credentials)));
    },
  );

  const promoteSession = Effect.fn("ApiClient.promoteSession")(function* (
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
      .pipe(authorized(tenantScoped(credentials)));
  });

  const replaceSessionTags = Effect.fn("ApiClient.replaceSessionTags")(function* (
    credentials: ApiCredentials,
    sessionId: string,
    tags: Record<string, string>,
  ) {
    return yield* api
      .replaceSessionTags(sessionId, { payload: { tags } })
      .pipe(authorized(tenantScoped(credentials)));
  });

  const listSnapshots = Effect.fn("ApiClient.listSnapshots")(function* (
    credentials: ApiCredentials,
    params: SnapshotsListParams = {},
  ) {
    return yield* api
      .listSnapshots({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          includeDeleted: params.includeDeleted || undefined,
          deleted: params.deleted,
          name: params.name,
          ...tagQuery(params.tags),
        }),
      })
      .pipe(authorized(tenantScoped(credentials)));
  });

  const deleteSnapshot = Effect.fn("ApiClient.deleteSnapshot")(function* (
    credentials: ApiCredentials,
    name: string,
  ) {
    return yield* api.deleteSnapshot(name, undefined).pipe(authorized(tenantScoped(credentials)));
  });

  const restoreSnapshot = Effect.fn("ApiClient.restoreSnapshot")(function* (
    credentials: ApiCredentials,
    name: string,
  ) {
    return yield* api.restoreSnapshot(name, undefined).pipe(authorized(tenantScoped(credentials)));
  });

  const replaceSnapshotTags = Effect.fn("ApiClient.replaceSnapshotTags")(function* (
    credentials: ApiCredentials,
    name: string,
    tags: Record<string, string>,
  ) {
    return yield* api
      .replaceSnapshotTags(name, { payload: { tags } })
      .pipe(authorized(tenantScoped(credentials)));
  });

  const updateSnapshot = Effect.fn("ApiClient.updateSnapshot")(function* (
    credentials: ApiCredentials,
    name: string,
    input: UpdateSnapshotInput,
  ) {
    return yield* api
      .updateSnapshot(name, { payload: input })
      .pipe(authorized(tenantScoped(credentials)));
  });

  const listEvents = Effect.fn("ApiClient.listEvents")(function* (
    credentials: ApiCredentials,
    params: EventsListParams = {},
  ) {
    return yield* api
      .listEvents({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
        }),
      })
      .pipe(authorized(tenantScoped(credentials)));
  });

  // Filters and scopes arrive from free-form UI state; the server validates them.

  const listAdminTokens = Effect.fn("ApiClient.listAdminTokens")(function* (
    credentials: ApiCredentials,
    params: TokensListParams = {},
  ) {
    return yield* api
      .listAdminTokens({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          tenantId: params.tenantId,
          name: params.name,
          authorityType: params.authorityType,
          revoked: params.revoked,
          scope: params.scope,
        }) as typeof Api.ListAdminTokensParams.Encoded,
      })
      .pipe(authorized({ credentials }));
  });

  const listTenantTokens = Effect.fn("ApiClient.listTenantTokens")(function* (
    credentials: ApiCredentials,
    params: TokensListParams = {},
  ) {
    return yield* api
      .listTenantTokens({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          name: params.name,
          revoked: params.revoked,
          scope: params.scope,
        }) as typeof Api.ListTenantTokensParams.Encoded,
      })
      .pipe(authorized({ credentials }));
  });

  const createAdminToken = Effect.fn("ApiClient.createAdminToken")(function* (
    credentials: ApiCredentials,
    input: CreateAdminTokenInput,
  ) {
    const systemAdmin = input.authorityType === "system_admin";
    return yield* api
      .createAdminToken({
        payload: {
          name: input.name,
          authorityType: input.authorityType,
          tenantId: input.tenantId ?? null,
          scopes: input.scopes,
          resourceMode: systemAdmin ? "all" : input.resourceMode,
          resourceGrants: systemAdmin ? [] : input.resourceGrants,
          expiresAt: input.expiresAt ?? null,
        } as typeof Api.CreateAdminTokenRequestJson.Encoded,
      })
      .pipe(authorized({ credentials }));
  });

  const createTenantToken = Effect.fn("ApiClient.createTenantToken")(function* (
    credentials: ApiCredentials,
    input: CreateTenantTokenInput,
  ) {
    return yield* api
      .createTenantToken({
        payload: {
          name: input.name,
          scopes: input.scopes,
          resourceMode: input.resourceMode,
          resourceGrants: input.resourceGrants,
          expiresAt: input.expiresAt ?? null,
        } as typeof Api.CreateTenantTokenRequestJson.Encoded,
      })
      .pipe(authorized({ credentials }));
  });

  const revokeAdminToken = Effect.fn("ApiClient.revokeAdminToken")(function* (
    credentials: ApiCredentials,
    tokenId: string,
  ) {
    yield* api.revokeAdminToken(tokenId, undefined).pipe(authorized({ credentials }));
  });

  const revokeTenantToken = Effect.fn("ApiClient.revokeTenantToken")(function* (
    credentials: ApiCredentials,
    tokenId: string,
  ) {
    yield* api.revokeTenantToken(tokenId, undefined).pipe(authorized({ credentials }));
  });

  return ApiClient.of({
    sessionAuthenticationFailures: Stream.fromPubSub(authenticationFailures),
    listLoginMethods,
    beginPasskeyLogin,
    finishPasskeyLogin,
    listPasskeys,
    beginPasskeyRegistration,
    finishPasskeyRegistration,
    renamePasskey,
    deletePasskey,
    loginWithPassword,
    loginWithAPIToken,
    completePasswordMFA,
    getSecurityStatus,
    setPassword,
    acceptUserInvitation,
    beginTOTPEnrollment,
    completeTOTPEnrollment,
    regenerateRecoveryCodes,
    disableTOTP,
    logoutWebSession,
    getHealth,
    getAuthMe,
    getBrowserChannels,
    getBrowserStatus,
    listTenants,
    createTenant,
    updateTenant,
    deleteTenant,
    restoreTenant,
    listUsers,
    createUser,
    getUser,
    updateUser,
    createUserInvitation,
    disableUser,
    restoreUser,
    listUserMemberships,
    upsertTenantMembership,
    deleteTenantMembership,
    listSessions,
    getSession,
    getSessionsBulk,
    createSession,
    deleteSession,
    reopenSession,
    suspendSession,
    rotateSessionToken,
    rotateCollaborationCapability,
    promoteSession,
    replaceSessionTags,
    downloadSessionRecording,
    listSnapshots,
    deleteSnapshot,
    restoreSnapshot,
    replaceSnapshotTags,
    updateSnapshot,
    listEvents,
    listAdminTokens,
    listTenantTokens,
    createAdminToken,
    createTenantToken,
    revokeAdminToken,
    revokeTenantToken,
  });
});

/** Provides ApiClient on top of an HttpClient. */
export const apiClientLayer = Layer.effect(ApiClient, makeApiClient);
