import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Api from "@aperture-browser/api-schema";
import {
  ApiAuthorization,
  Authorization,
  webSessionCredentials,
  type ApiCredentials,
} from "../authorization/service.ts";
import {
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
import { AuthApi, type PasskeyCredentialJSON } from "./service.ts";

const jsonBody = (body: unknown) => ({ body: HttpBody.jsonUnsafe(body) });

export const makeAuthApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const http = HttpClient.filterStatusOk(httpClient);
  const api = Api.make(httpClient);
  const anonymous = authorize(Authorization.anonymous);
  const webSession = authorize(Authorization.webSession);

  const listLoginMethods = Effect.fn("AuthApi.listLoginMethods")(function* () {
    return yield* http
      .get("/auth/login-methods")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(LoginMethods)), anonymous);
  });

  const loginWithPassword = Effect.fn("AuthApi.loginWithPassword")(function* (
    email: string,
    password: string,
  ) {
    return yield* http
      .post("/auth/password/login", jsonBody({ email, password }))
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(PasswordLoginResponse)), anonymous);
  });

  const completePasswordMFA = Effect.fn("AuthApi.completePasswordMFA")(function* (code: string) {
    yield* http.post("/auth/password/login/mfa", jsonBody({ code })).pipe(anonymous);
  });

  const loginWithAPIToken = Effect.fn("AuthApi.loginWithAPIToken")(function* (token: string) {
    yield* http.post("/auth/token/login", jsonBody({ token })).pipe(anonymous);
  });

  const beginPasskeyLogin = Effect.fn("AuthApi.beginPasskeyLogin")(function* () {
    return yield* http
      .post("/auth/passkeys/login/options")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyLoginOptions)), anonymous);
  });

  const finishPasskeyLogin = Effect.fn("AuthApi.finishPasskeyLogin")(function* (
    credential: PasskeyCredentialJSON,
  ) {
    yield* http.post("/auth/passkeys/login/finish", jsonBody(credential)).pipe(anonymous);
  });

  const acceptUserInvitation = Effect.fn("AuthApi.acceptUserInvitation")(function* (
    token: string,
    password: string,
  ) {
    yield* http.post("/auth/invitations/accept", jsonBody({ token, password })).pipe(anonymous);
  });

  const logoutWebSession = Effect.fn("AuthApi.logoutWebSession")(function* () {
    yield* http.post("/auth/logout").pipe(webSession);
  });

  const getAuthMe = Effect.fn("AuthApi.getAuthMe")(function* (
    selectedTenantId: string | null = null,
    credentials: ApiCredentials = webSessionCredentials,
  ) {
    return yield* api.getCurrentPrincipal(undefined).pipe(
      authorize({
        credentials: { ...credentials, selectedTenantId },
        tenantHeader: "optional",
      }),
    );
  });

  const getSecurityStatus = Effect.fn("AuthApi.getSecurityStatus")(function* () {
    return yield* http
      .get("/auth/security")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(SecurityStatus)), webSession);
  });

  const setPassword = Effect.fn("AuthApi.setPassword")(function* (
    currentPassword: string,
    newPassword: string,
  ) {
    yield* http.put("/auth/password", jsonBody({ currentPassword, newPassword })).pipe(webSession);
  });

  const listPasskeys = Effect.fn("AuthApi.listPasskeys")(function* () {
    return yield* http
      .get("/auth/passkeys")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Passkeys)), webSession);
  });

  const beginPasskeyRegistration = Effect.fn("AuthApi.beginPasskeyRegistration")(function* (
    name: string,
  ) {
    return yield* http
      .post("/auth/passkeys/registration/options", jsonBody({ name }))
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyRegistrationOptions)),
        webSession,
      );
  });

  const finishPasskeyRegistration = Effect.fn("AuthApi.finishPasskeyRegistration")(function* (
    credential: PasskeyCredentialJSON,
  ) {
    return yield* http
      .post("/auth/passkeys/registration/finish", jsonBody(credential))
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyMutation)), webSession);
  });

  const renamePasskey = Effect.fn("AuthApi.renamePasskey")(function* (
    passkeyId: string,
    name: string,
  ) {
    return yield* http
      .patch(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, jsonBody({ name }))
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(PasskeyMutation)), webSession);
  });

  const deletePasskey = Effect.fn("AuthApi.deletePasskey")(function* (passkeyId: string) {
    yield* http.del(`/auth/passkeys/${encodeURIComponent(passkeyId)}`).pipe(webSession);
  });

  const beginTOTPEnrollment = Effect.fn("AuthApi.beginTOTPEnrollment")(function* () {
    return yield* http
      .post("/auth/totp/enrollment/options")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(TOTPEnrollment)), webSession);
  });

  const completeTOTPEnrollment = Effect.fn("AuthApi.completeTOTPEnrollment")(function* (
    code: string,
  ) {
    return yield* http
      .post("/auth/totp/enrollment/finish", jsonBody({ code }))
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RecoveryCodes)), webSession);
  });

  const regenerateRecoveryCodes = Effect.fn("AuthApi.regenerateRecoveryCodes")(function* (
    code: string,
  ) {
    return yield* http
      .post("/auth/totp/recovery-codes", jsonBody({ code }))
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(RecoveryCodes)), webSession);
  });

  const disableTOTP = Effect.fn("AuthApi.disableTOTP")(function* (code: string) {
    yield* http.post("/auth/totp/disable", jsonBody({ code })).pipe(webSession);
  });

  return AuthApi.of({
    listLoginMethods,
    loginWithPassword,
    completePasswordMFA,
    loginWithAPIToken,
    beginPasskeyLogin,
    finishPasskeyLogin,
    acceptUserInvitation,
    logoutWebSession,
    getAuthMe,
    getSecurityStatus,
    setPassword,
    listPasskeys,
    beginPasskeyRegistration,
    finishPasskeyRegistration,
    renamePasskey,
    deletePasskey,
    beginTOTPEnrollment,
    completeTOTPEnrollment,
    regenerateRecoveryCodes,
    disableTOTP,
  });
});

export const authApiLayer = Layer.effect(AuthApi, makeAuthApi);
