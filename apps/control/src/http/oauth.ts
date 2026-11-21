import { Scope } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Grants } from "../grants/service.ts";
import type { Tokens } from "../grants/schemas.ts";
import { Settings } from "../settings/service.ts";
import { PATH as MCP_PATH, RESOURCE_METADATA_PATH } from "./mcp.ts";
import { originOf } from "./origin.ts";

const SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const REGISTER_PATH = "/oauth/register";
const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";
/** The console's page where a person decides what an app gets. */
const CONSENT_PATH = "/oauth/consent";
const BAD_REQUEST = 400;
const CREATED = 201;
const CHALLENGE_METHOD = "S256";

const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String),
});

const Authorization = Schema.Struct({
  response_type: Schema.optional(Schema.String),
  client_id: Schema.String,
  redirect_uri: Schema.String,
  state: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  code_challenge: Schema.optional(Schema.String),
  code_challenge_method: Schema.optional(Schema.String),
});

const Exchange = Schema.Union([
  Schema.Struct({
    grant_type: Schema.Literal("authorization_code"),
    code: Schema.String,
    client_id: Schema.String,
    redirect_uri: Schema.String,
    code_verifier: Schema.String,
  }),
  Schema.Struct({
    grant_type: Schema.Literal("refresh_token"),
    refresh_token: Schema.String,
    client_id: Schema.String,
  }),
]);

/** A refusal as OAuth tells one: a code a client acts on, and words for whoever reads them. */
const refused = (error: string, description: string) =>
  HttpServerResponse.jsonUnsafe(
    { error, error_description: description },
    { status: BAD_REQUEST, headers: { "cache-control": "no-store" } },
  );

const issued = (tokens: Tokens) =>
  HttpServerResponse.jsonUnsafe(
    {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scopes.join(" "),
    },
    { headers: { "cache-control": "no-store" } },
  );

/**
 * OAuth for apps that act as a person's account, as MCP's authorization asks it of a
 * server: what a client discovers it by, registers at, sends the person to, and gets
 * its tokens from.
 */
export const layer = HttpRouter.use(
  Effect.fn(function* (router) {
    const grants = yield* Grants;
    const settings = yield* Settings;

    const resourceMetadata = (request: HttpServerRequest.HttpServerRequest) => {
      const origin = originOf(settings, request);
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({
          resource: `${origin}${MCP_PATH}`,
          authorization_servers: [origin],
          scopes_supported: Scope.literals,
          bearer_methods_supported: ["header"],
        }),
      );
    };

    const serverMetadata = (request: HttpServerRequest.HttpServerRequest) => {
      const origin = originOf(settings, request);
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({
          issuer: origin,
          authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
          token_endpoint: `${origin}${TOKEN_PATH}`,
          registration_endpoint: `${origin}${REGISTER_PATH}`,
          scopes_supported: Scope.literals,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: [CHALLENGE_METHOD],
          // An app keeps no secret: it proves itself by what it made its request with.
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
    };

    const register = Effect.fn("OAuth.http.register")(
      function* () {
        const asked = yield* HttpServerRequest.schemaBodyJson(Registration);
        const client = yield* grants.register({
          name: asked.client_name,
          redirectUris: asked.redirect_uris,
        });
        return HttpServerResponse.jsonUnsafe(
          {
            client_id: client.id,
            client_name: client.name,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
          { status: CREATED },
        );
      },
      Effect.catchTag("ClientInvalid", (error) =>
        Effect.succeed(refused("invalid_redirect_uri", error.message)),
      ),
      Effect.catch(() =>
        Effect.succeed(refused("invalid_client_metadata", "the registration is not read")),
      ),
    );

    // The person decides on a page of the console, which asks the API who the app is and
    // tells it what they decided: this only sees that the request is one to decide on.
    const authorize = Effect.fn("OAuth.http.authorize")(
      function* (request: HttpServerRequest.HttpServerRequest) {
        const asked = yield* HttpServerRequest.schemaSearchParams(Authorization);
        yield* grants.asking({ clientId: asked.client_id, redirectUri: asked.redirect_uri });
        const back = new URL(asked.redirect_uri);
        if (asked.state !== undefined) {
          back.searchParams.set("state", asked.state);
        }
        if (
          asked.response_type !== "code" ||
          asked.code_challenge === undefined ||
          asked.code_challenge_method !== CHALLENGE_METHOD
        ) {
          back.searchParams.set("error", "invalid_request");
          back.searchParams.set(
            "error_description",
            `a request asks for a code, with a ${CHALLENGE_METHOD} code challenge`,
          );
          return HttpServerResponse.redirect(back);
        }
        const query = request.url.slice(request.url.indexOf("?"));
        return HttpServerResponse.redirect(`${CONSENT_PATH}${query}`);
      },
      Effect.catchTag("OAuthClientNotFound", () =>
        Effect.succeed(refused("invalid_client", "no app registered as that")),
      ),
      Effect.catchTag("RedirectRefused", (error) =>
        Effect.succeed(refused("invalid_request", error.message)),
      ),
      Effect.catch(() =>
        Effect.succeed(refused("invalid_request", "the request names no app to answer")),
      ),
    );

    const token = Effect.fn("OAuth.http.token")(
      function* () {
        const asked = yield* HttpServerRequest.schemaBodyUrlParams(Exchange);
        return issued(
          asked.grant_type === "authorization_code"
            ? yield* grants.exchange({
                code: asked.code,
                clientId: asked.client_id,
                redirectUri: asked.redirect_uri,
                codeVerifier: asked.code_verifier,
              })
            : yield* grants.refresh({
                clientId: asked.client_id,
                refreshToken: asked.refresh_token,
              }),
        );
      },
      Effect.catchTag("GrantRefused", (error) =>
        Effect.succeed(refused("invalid_grant", error.message)),
      ),
      Effect.catch(() =>
        Effect.succeed(refused("invalid_request", "the request is for no tokens this gives")),
      ),
    );

    yield* router.add("GET", RESOURCE_METADATA_PATH, resourceMetadata);
    yield* router.add("GET", `${RESOURCE_METADATA_PATH}${MCP_PATH}`, resourceMetadata);
    yield* router.add("GET", SERVER_METADATA_PATH, serverMetadata);
    yield* router.add("POST", REGISTER_PATH, register);
    yield* router.add("GET", AUTHORIZE_PATH, authorize);
    yield* router.add("POST", TOKEN_PATH, token);
  }),
);
