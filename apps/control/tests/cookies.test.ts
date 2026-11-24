import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Control from "./src/control.ts";

/** What an answer to a request for the cookie that carries a token sets. */
const kept = (headers: Record<string, string>) =>
  Effect.gen(function* () {
    const control = yield* Control.Control;
    const http = yield* HttpClient.HttpClient;
    const answer = yield* http.execute(
      HttpClientRequest.post(`${control.url}/api/control/route/cookie`).pipe(
        HttpClientRequest.bearerToken(control.bootstrapToken),
        HttpClientRequest.setHeaders(headers),
      ),
    );
    expect(answer.status).toBe(204);
    return String(answer.headers["set-cookie"]);
  });

suite(Control.layer({ publicUrl: "https://aperture.example" }))(
  "cookies of a control plane that is reached over TLS",
  (it) => {
    it.effect("a cookie is for TLS alone, whatever the proxy before it was spoken to in", () =>
      Effect.gen(function* () {
        // What speaks TLS stands before a proxy that hears plain HTTP, and says so.
        expect(yield* kept({ "x-forwarded-proto": "http" })).toMatch(/; Secure/u);
        expect(yield* kept({})).toMatch(/; Secure/u);
      }),
    );
  },
);

suite(Control.layer())("cookies of a control plane that says no address of its own", (it) => {
  it.effect("a cookie is for TLS where the request came over it, and not otherwise", () =>
    Effect.gen(function* () {
      expect(yield* kept({ "x-forwarded-proto": "https" })).toMatch(/; Secure/u);
      expect(yield* kept({})).not.toMatch(/; Secure/u);
    }),
  );
});
