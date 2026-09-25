import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import * as Function from "effect/Function";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { toApiRequestError } from "../errors.ts";
import {
  ApiAuthorization,
  resolveTenantHeader,
  TENANT_HEADER,
  type Authorization,
} from "./service.ts";

/** The authorization of the call a request belongs to; set by `authorize`. */
const CurrentAuthorization = Context.Reference<Authorization>(
  "@aperture-browser/api-client/CurrentAuthorization",
  { defaultValue: () => ({}) },
);

const authorizeRequest = (request: HttpClientRequest.HttpClientRequest) =>
  CurrentAuthorization.useSync(({ credentials, bearerToken, tenantHeader = "none" }) => {
    const token =
      bearerToken ?? (credentials?.kind === "bearer" ? credentials.token.trim() : undefined);
    const tenantId = credentials ? resolveTenantHeader(credentials, tenantHeader) : undefined;
    return request.pipe(
      HttpClientRequest.acceptJson,
      token ? HttpClientRequest.bearerToken(token) : Function.identity,
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

/**
 * Decorates the HttpClient so each request carries the authorization of the `authorize`
 * call it runs in.
 */
export const authorizedHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, HttpClient.mapRequestEffect(authorizeRequest)),
);

export const makeApiAuthorization = Effect.gen(function* () {
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
    authorize,
    sessionAuthenticationFailures: Stream.fromPubSub(failures),
  });
});

export const apiAuthorizationLayer = Layer.effect(ApiAuthorization, makeApiAuthorization);
