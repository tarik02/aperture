import { Context, Effect, Layer, PubSub, Stream, type Schema } from "effect";
import { identity } from "effect/Function";
import { HttpClient, HttpClientRequest, type HttpClientError } from "effect/unstable/http";
import { toApiRequestError } from "../errors.ts";
import {
  ApiAuthorization,
  resolveTenantHeader,
  TENANT_HEADER,
  type Authorization,
} from "./service.ts";

/** The authorization of the call a request belongs to; set by `authorize`. */
const CurrentAuthorization = Context.Reference<Authorization>(
  "@aperture/api-client/CurrentAuthorization",
  { defaultValue: () => ({}) },
);

const authorizeRequest = (request: HttpClientRequest.HttpClientRequest) =>
  CurrentAuthorization.useSync(({ credentials, bearerToken, tenantHeader = "none" }) => {
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

export const makeApiAuthorization = Effect.gen(function* () {
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequestEffect(authorizeRequest),
  );
  const failures = yield* PubSub.unbounded<void>();

  const authorize =
    (authorization: Authorization) =>
    <A, R>(self: Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError, R>) =>
      self.pipe(
        toApiRequestError,
        Effect.tapError((error) =>
          authorization.credentials?.kind === "session" &&
          sessionAuthenticationFailureCodes.has(error.code)
            ? PubSub.publish(failures, undefined)
            : Effect.void,
        ),
        Effect.provideService(CurrentAuthorization, authorization),
      );

  return ApiAuthorization.of({
    httpClient,
    authorize,
    sessionAuthenticationFailures: Stream.fromPubSub(failures),
  });
});

export const apiAuthorizationLayer = Layer.effect(ApiAuthorization, makeApiAuthorization);
