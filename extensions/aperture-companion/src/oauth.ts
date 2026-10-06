import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CompanionError } from "./chrome.ts";
import { NonEmptyString, Timestamp } from "./schema.ts";

export const AuthenticationMethod = Schema.Literals(["oauth", "token"]);
export type AuthenticationMethod = typeof AuthenticationMethod.Type;

export const OAuthSession = Schema.Struct({
  issuer: NonEmptyString,
  clientId: NonEmptyString,
  tokenEndpoint: NonEmptyString,
  revocationEndpoint: NonEmptyString,
  refreshToken: Schema.RedactedFromValue(NonEmptyString),
  expiresAt: Timestamp,
});
export type OAuthSession = typeof OAuthSession.Type;

const Metadata = Schema.Struct({
  issuer: Schema.URLFromString,
  authorization_endpoint: Schema.URLFromString,
  token_endpoint: Schema.URLFromString,
  registration_endpoint: Schema.URLFromString,
  revocation_endpoint: Schema.URLFromString,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  grant_types_supported: Schema.Array(Schema.String),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.String),
});

const RegistrationRequest = Schema.Struct({
  client_name: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  grant_types: Schema.Array(Schema.String),
  response_types: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.Literal("none"),
});
const Registration = Schema.Struct({ client_id: NonEmptyString });
const Tokens = Schema.Struct({
  access_token: Schema.RedactedFromValue(NonEmptyString),
  token_type: Schema.String.check(Schema.makeFilter((value) => value.toLowerCase() === "bearer")),
  expires_in: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  refresh_token: Schema.RedactedFromValue(NonEmptyString),
});
const OAuthFailure = Schema.Struct({ error: NonEmptyString });
const AuthorizationResponse = Schema.Union([
  Schema.Struct({ state: NonEmptyString, iss: NonEmptyString, code: NonEmptyString }),
  Schema.Struct({ state: NonEmptyString, iss: NonEmptyString, error: NonEmptyString }),
]);

const httpLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  }),
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

const requestJson = Effect.fn("oauth.requestJson")(function* <A, I>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, I>,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.catchTag("HttpClientError", () =>
        Effect.fail(new CompanionError({ message: "Could not reach Aperture for site login" })),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) {
      return yield* new CompanionError({
        message: "This instance does not offer site login. Use an API token instead.",
      });
    }
    const failure = yield* HttpClientResponse.schemaBodyJson(OAuthFailure)(response).pipe(
      Effect.catchTag(["HttpClientError", "SchemaError"], () =>
        Effect.fail(new CompanionError({ message: "Aperture rejected the site login request" })),
      ),
    );
    return yield* new CompanionError({
      message:
        failure.error === "invalid_grant" || failure.error === "invalid_client"
          ? "Aperture access expired or was revoked. Remove this connection and connect again."
          : "Aperture rejected the site login request",
    });
  }
  return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.catchTag(["HttpClientError", "SchemaError"], () =>
      Effect.fail(
        new CompanionError({ message: "Aperture returned an invalid site login response" }),
      ),
    ),
  );
});

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** Opens Aperture's login and consent page, then exchanges the code using PKCE. */
export const authorize = Effect.fn("oauth.authorize")(function* (origin: string) {
  const metadata = yield* requestJson(
    HttpClientRequest.get(`${origin}/.well-known/oauth-authorization-server`),
    Metadata,
  );
  const endpoints = [
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    metadata.revocation_endpoint,
  ];
  if (
    endpoints.some(
      (url) =>
        url.origin !== origin || url.username !== "" || url.password !== "" || url.hash !== "",
    ) ||
    !metadata.code_challenge_methods_supported.includes("S256") ||
    !metadata.grant_types_supported.includes("refresh_token") ||
    !metadata.token_endpoint_auth_methods_supported.includes("none")
  ) {
    return yield* new CompanionError({
      message: "This instance does not support the extension's site login",
    });
  }
  const redirectUri = chrome.identity.getRedirectURL("oauth");
  const registrationRequest = yield* HttpClientRequest.post(
    metadata.registration_endpoint.href,
  ).pipe(
    HttpClientRequest.schemaBodyJson(RegistrationRequest)({
      client_name: "Aperture Companion",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    Effect.catchTag("HttpBodyError", () =>
      Effect.fail(new CompanionError({ message: "Could not prepare Aperture site login" })),
    ),
  );
  const registration = yield* requestJson(registrationRequest, Registration);
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    catch: () => new CompanionError({ message: "Could not prepare secure Aperture site login" }),
  });
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    state,
    scope: "sessions:read sessions:write snapshots:read snapshots:write",
  }).toString();
  const callback = yield* Effect.tryPromise({
    try: () => chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }),
    catch: () =>
      new CompanionError({
        message: "Site login was closed or could not complete. Try connecting again.",
      }),
  });
  const returned = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(callback).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(new CompanionError({ message: "Site login returned an invalid callback" })),
    ),
  );
  const expected = new URL(redirectUri);
  if (
    returned.origin !== expected.origin ||
    returned.pathname !== expected.pathname ||
    returned.hash !== ""
  ) {
    return yield* new CompanionError({ message: "Site login returned an unexpected callback" });
  }
  const result = yield* Schema.decodeUnknownEffect(AuthorizationResponse)(
    Object.fromEntries(returned.searchParams),
  ).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new CompanionError({ message: "Site login returned an invalid authorization response" }),
      ),
    ),
  );
  if (result.state !== state || result.iss !== metadata.issuer.href.replace(/\/$/, "")) {
    return yield* new CompanionError({
      message: "Site login could not verify the authorization response",
    });
  }
  if ("error" in result) {
    return yield* new CompanionError({
      message:
        result.error === "access_denied"
          ? "Aperture access was not approved"
          : "Aperture could not authorize this connection",
    });
  }
  const issuedAt = Date.now();
  const tokens = yield* requestJson(
    HttpClientRequest.post(metadata.token_endpoint.href).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: result.code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    ),
    Tokens,
  );
  return {
    token: tokens.access_token,
    oauth: {
      issuer: result.iss,
      clientId: registration.client_id,
      tokenEndpoint: metadata.token_endpoint.href,
      revocationEndpoint: metadata.revocation_endpoint.href,
      refreshToken: tokens.refresh_token,
      expiresAt: issuedAt + tokens.expires_in * 1000,
    } satisfies OAuthSession,
  };
}, Effect.provide(httpLayer));

export const refresh = Effect.fn("oauth.refresh")(function* (session: OAuthSession) {
  const issuedAt = Date.now();
  const tokens = yield* requestJson(
    HttpClientRequest.post(session.tokenEndpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "refresh_token",
        client_id: session.clientId,
        refresh_token: Redacted.value(session.refreshToken),
      }),
    ),
    Tokens,
  );
  return {
    token: tokens.access_token,
    oauth: {
      ...session,
      refreshToken: tokens.refresh_token,
      expiresAt: issuedAt + tokens.expires_in * 1000,
    },
  };
}, Effect.provide(httpLayer));

export const revoke = Effect.fn("oauth.revoke")(
  function* (session: OAuthSession) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(session.revocationEndpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: session.clientId,
          token: Redacted.value(session.refreshToken),
          token_type_hint: "refresh_token",
        }),
      ),
    );
    if (response.status !== 200) {
      return yield* new CompanionError({
        message: "Could not revoke Aperture access. Try again or revoke it in Connected apps.",
      });
    }
  },
  Effect.catchTag("HttpClientError", () =>
    Effect.fail(
      new CompanionError({
        message: "Could not revoke Aperture access. Try again or revoke it in Connected apps.",
      }),
    ),
  ),
  Effect.provide(httpLayer),
);
