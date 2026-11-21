import { request } from "@aperture-browser/e2e/src/http.ts";
import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import { signedIn } from "./src/person.ts";

const REDIRECT = "http://127.0.0.1:9/callback";
const VERIFIER = "a-verifier-the-app-made-and-keeps-to-itself-0123456789";

const Challenge = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
});
const Server = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
});
const Registered = Schema.Struct({ client_id: Schema.String, client_name: Schema.String });
const Approved = Schema.Struct({ redirectTo: Schema.String });
const Issued = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
});
const Refused = Schema.Struct({ error: Schema.String });
const Grants = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    clientName: Schema.String,
    scopes: Schema.Array(Schema.String),
    resources: Schema.NullOr(Schema.Struct({ sessions: Schema.Array(Schema.String) })),
  }),
);
const Listed = Schema.fromJsonString(Schema.Struct({ sessions: Schema.Array(Schema.Unknown) }));

/** What an app proves itself by: the digest of what it keeps to itself. */
const challenge = Effect.promise(() =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER)),
).pipe(Effect.map((digest) => Base64Url.encode(new Uint8Array(digest))));

for (const stores of Control.STORES) {
  suite(Control.layer({ stores }))(`OAuth for MCP clients, kept in ${stores}`, (it) => {
    let ada: Effect.Success<ReturnType<typeof signedIn>>;
    let server: typeof Server.Type;
    let client = "";
    let tokens: typeof Issued.Type;

    /** A request as the person's browser makes it: with their cookies. */
    const asPerson = Effect.fn(function* (
      method: "GET" | "POST" | "DELETE",
      path: string,
      body?: object,
    ) {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const answer = yield* http.execute(
        HttpClientRequest.make(method)(`${control.url}/api/control${path}`).pipe(
          HttpClientRequest.setHeader("cookie", ada.cookie),
          body === undefined ? (bare) => bare : HttpClientRequest.bodyJsonUnsafe(body),
        ),
      );
      return {
        status: answer.status,
        body: answer.status === 204 ? undefined : yield* answer.json,
      };
    });

    /** What the token endpoint answers a form with. */
    const exchange = Effect.fn(function* (form: Record<string, string>) {
      const http = yield* HttpClient.HttpClient;
      const answer = yield* http.execute(
        HttpClientRequest.post(server.token_endpoint).pipe(HttpClientRequest.bodyUrlParams(form)),
      );
      return { status: answer.status, body: yield* answer.json };
    });

    /** The person's yes to the app, and the code their browser carries back to it. */
    const approve = Effect.fn(function* (granted: object) {
      const answer = yield* asPerson("POST", "/oauth/grants", {
        clientId: client,
        redirectUri: REDIRECT,
        state: "the app's own",
        codeChallenge: yield* challenge,
        ...granted,
      });
      expect(answer.status).toBe(201);
      const back = new URL((yield* Schema.decodeUnknownEffect(Approved)(answer.body)).redirectTo);
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      expect(back.searchParams.get("state")).toBe("the app's own");
      return back.searchParams.get("code") ?? "";
    });

    const redeem = (code: string) =>
      exchange({
        grant_type: "authorization_code",
        code,
        client_id: client,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      });

    it.effect("a client without a token is told where it gets one, and registers itself", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const http = yield* HttpClient.HttpClient;
        const nobody = yield* http.execute(
          HttpClientRequest.post(`${control.url}/mcp`).pipe(HttpClientRequest.bodyJsonUnsafe({})),
        );
        expect(nobody.status).toBe(401);
        const [, metadata] =
          /resource_metadata="([^"]+)"/u.exec(nobody.headers["www-authenticate"] ?? "") ?? [];
        expect(metadata).toBe(`${control.url}/.well-known/oauth-protected-resource/mcp`);

        const resource = yield* http.get(metadata ?? "").pipe(
          Effect.flatMap((answer) => answer.json),
          Effect.flatMap(Schema.decodeUnknownEffect(Challenge)),
        );
        expect(resource.resource).toBe(`${control.url}/mcp`);
        server = yield* http
          .get(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)
          .pipe(
            Effect.flatMap((answer) => answer.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Server)),
          );
        expect(server.issuer).toBe(control.url);
        expect(server.code_challenge_methods_supported).toEqual(["S256"]);

        const register = (said: object) =>
          http.execute(
            HttpClientRequest.post(server.registration_endpoint).pipe(
              HttpClientRequest.bodyJsonUnsafe(said),
            ),
          );
        // An app is answered over TLS or on its own machine, and never by a script.
        for (const uri of [
          "javascript:alert(1)",
          "http://elsewhere.example/callback",
          "no address",
        ]) {
          expect((yield* register({ redirect_uris: [uri] })).status, uri).toBe(400);
        }
        expect((yield* register({ client_name: "Nothing" })).status).toBe(400);
        const registered = yield* register({ client_name: "Checks", redirect_uris: [REDIRECT] });
        expect(registered.status).toBe(201);
        const made = yield* Schema.decodeUnknownEffect(Registered)(yield* registered.json);
        expect(made.client_name).toBe("Checks");
        client = made.client_id;
      }),
    );

    it.effect("a request to authorize goes to the page where the person decides", () =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const authorize = (query: Record<string, string>) =>
          http.execute(
            HttpClientRequest.get(server.authorization_endpoint).pipe(
              HttpClientRequest.setUrlParams(query),
            ),
          );
        const asked = {
          response_type: "code",
          client_id: client,
          redirect_uri: REDIRECT,
          state: "the app's own",
          code_challenge: yield* challenge,
          code_challenge_method: "S256",
        };
        const sent = yield* authorize(asked);
        expect(sent.status).toBe(302);
        const page = new URL(sent.headers["location"] ?? "", server.issuer);
        expect(page.pathname).toBe("/oauth/consent");
        expect(page.searchParams.get("client_id")).toBe(client);
        expect(page.searchParams.get("code_challenge")).toBe(asked.code_challenge);

        // Nothing is sent to an address the app did not register, nor for an app nobody knows.
        expect(
          (yield* authorize({ ...asked, redirect_uri: "https://elsewhere.example/" })).status,
        ).toBe(400);
        expect((yield* authorize({ ...asked, client_id: "nobody" })).status).toBe(400);
        // An app that proves itself by nothing is told so where it is answered.
        const { code_challenge: _, ...unproven } = asked;
        const back = yield* authorize(unproven);
        expect(back.status).toBe(302);
        expect(back.headers["location"]).toMatch(
          /^http:\/\/127\.0\.0\.1:9\/callback\?.*error=invalid_request/u,
        );
      }),
    );

    it.effect("a signed-in person gives a grant, and the app exchanges its code for tokens", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        ada = yield* signedIn("Ada", `ada-${stores}@example.test`);
        const asking = yield* asPerson(
          "GET",
          `/oauth/request?clientId=${client}&redirectUri=${encodeURIComponent(REDIRECT)}`,
        );
        expect(asking).toMatchObject({ status: 200, body: { clientName: "Checks" } });
        // Nobody gives a grant who is not signed in.
        const unsigned = yield* request(control.url, "", "POST", "/api/control/oauth/grants", {
          clientId: client,
          redirectUri: REDIRECT,
          codeChallenge: yield* challenge,
          scopes: ["sessions:read"],
        });
        expect(unsigned.status).toBe(401);

        const code = yield* approve({ scopes: ["sessions:read"] });
        expect(code).not.toBe("");
        // The app proves it is the one that asked, with what it kept to itself.
        const stolen = yield* exchange({
          grant_type: "authorization_code",
          code: yield* approve({ scopes: ["sessions:read"] }),
          client_id: client,
          redirect_uri: REDIRECT,
          code_verifier: "what someone else made up",
        });
        expect(stolen).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

        const redeemed = yield* redeem(yield* approve({ scopes: ["sessions:read"] }));
        expect(redeemed.status).toBe(200);
        tokens = yield* Schema.decodeUnknownEffect(Issued)(redeemed.body);
        expect(tokens).toMatchObject({ token_type: "Bearer", scope: "sessions:read" });
        // A code is good once, and one that was replaced not at all.
        expect((yield* redeem(code)).status).toBe(400);
      }),
    );

    it.effect("the app's token is the person's account, held to what the grant says", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const agent = yield* Mcp.connect(control.url, tokens.access_token);
        const listed = yield* agent
          .call("sessions.list", {})
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));
        expect(listed.sessions).toEqual([]);
        const refused = yield* Effect.flip(agent.call("sessions.create", {}));
        expect(refused.reason).toMatch(/not for sessions:write/u);
        const other = yield* Effect.flip(agent.call("snapshots.list", {}));
        expect(other.reason).toMatch(/not for snapshots:read/u);

        const account = yield* request(
          control.url,
          tokens.access_token,
          "GET",
          "/api/control/account",
        );
        expect(account).toMatchObject({ status: 200, body: { id: ada.account.id } });
        // A grant gives none itself: it is not for that.
        const further = yield* request(
          control.url,
          tokens.access_token,
          "POST",
          "/api/control/oauth/grants",
          {
            clientId: client,
            redirectUri: REDIRECT,
            codeChallenge: yield* challenge,
            scopes: ["sessions:read"],
          },
        );
        expect(further.status).toBe(403);
      }),
    );

    it.effect("a refresh token gets the next tokens, once", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const refresh = (token: string) =>
          exchange({ grant_type: "refresh_token", refresh_token: token, client_id: client });
        const next = yield* refresh(tokens.refresh_token);
        expect(next.status).toBe(200);
        const fresh = yield* Schema.decodeUnknownEffect(Issued)(next.body);
        expect(fresh.access_token).not.toBe(tokens.access_token);
        expect(yield* refresh(tokens.refresh_token)).toMatchObject({
          status: 400,
          body: { error: "invalid_grant" },
        });
        expect(
          (yield* Schema.decodeUnknownEffect(Refused)((yield* refresh("nobody's")).body)).error,
        ).toBe("invalid_grant");
        tokens = fresh;
        const account = yield* request(
          control.url,
          tokens.access_token,
          "GET",
          "/api/control/account",
        );
        expect(account.status).toBe(200);
      }),
    );

    it.effect("a grant held to resources reaches those alone, and taking it back ends it", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        // The same app is given another grant, which takes the place of the first.
        const redeemed = yield* redeem(
          yield* approve({
            scopes: ["sessions:write"],
            resources: { workspaces: [], sessions: ["one-session"], snapshots: [] },
          }),
        );
        const held = yield* Schema.decodeUnknownEffect(Issued)(redeemed.body);
        expect(
          (yield* request(control.url, tokens.access_token, "GET", "/api/control/account")).status,
        ).toBe(401);
        const made = yield* request(
          control.url,
          held.access_token,
          "POST",
          "/api/control/sessions",
          {},
        );
        expect(made).toMatchObject({ status: 403, body: { _tag: "Forbidden" } });

        const listed = yield* asPerson("GET", "/oauth/grants");
        const grants = yield* Schema.decodeUnknownEffect(Grants)(listed.body);
        expect(grants).toMatchObject([
          {
            clientName: "Checks",
            scopes: ["sessions:write"],
            resources: { sessions: ["one-session"] },
          },
        ]);

        // Another person neither sees the grant nor takes it back.
        const eve = yield* Control.account("Eve");
        expect(yield* eve.api.grants.list()).toEqual([]);
        expect(
          (yield* Effect.flip(eve.api.grants.revoke({ params: { id: grants[0]?.id ?? "" } })))._tag,
        ).toBe("GrantNotFound");

        expect((yield* asPerson("DELETE", `/oauth/grants/${grants[0]?.id}`)).status).toBe(204);
        expect((yield* asPerson("GET", "/oauth/grants")).body).toEqual([]);
        expect(
          (yield* request(control.url, held.access_token, "GET", "/api/control/account")).status,
        ).toBe(401);
        expect((yield* request(control.url, held.access_token, "POST", "/mcp", {})).status).toBe(
          401,
        );
        const refreshed = yield* exchange({
          grant_type: "refresh_token",
          refresh_token: held.refresh_token,
          client_id: client,
        });
        expect(refreshed).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      }),
    );
  });
}
