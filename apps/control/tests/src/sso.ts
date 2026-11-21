import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as Dex from "./dex.ts";

const Started = Schema.Struct({ url: Schema.String });
/** More than the way through the provider and back ever takes. */
const STEPS = 12;
const REDIRECTS = [301, 302, 303, 307, 308];

/** Where signing in through the provider ended, and what the browser carries from then on. */
export interface Landed {
  /** The address the browser was sent to last, below the control plane's own. */
  readonly at: string;
  readonly cookie: string;
}

/**
 * Signs in through the provider as a browser does, without one: asks the control plane
 * where to go, gives the provider the email and the password at its form, and follows it
 * back until the control plane sends the browser to a page of the console.
 */
export const signInThrough = Effect.fn("Control.signInThrough")(function* (
  base: string,
  connector: Dex.Connector,
  email: string,
  to = "/-/sessions",
) {
  const http = yield* HttpClient.HttpClient;
  /** What each origin had the browser keep. */
  const kept = new Map<string, Map<string, string>>();
  const keep = (url: URL, answer: HttpClientResponse.HttpClientResponse) => {
    const cookies = kept.get(url.origin) ?? new Map<string, string>();
    kept.set(url.origin, cookies);
    for (const [name, value] of Object.entries(Cookies.toRecord(answer.cookies))) {
      if (value === "") {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
  };
  const carried = (url: URL) =>
    [...(kept.get(url.origin) ?? [])]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
  const send = Effect.fn(function* (asked: HttpClientRequest.HttpClientRequest, url: URL) {
    const answer = yield* http.execute(
      asked.pipe(HttpClientRequest.setHeaders({ cookie: carried(url), origin: url.origin })),
    );
    keep(url, answer);
    return answer;
  });

  const start = new URL("/api/auth/sign-in/social", base);
  const started = yield* send(
    HttpClientRequest.post(start).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        provider: Dex.PROVIDER,
        callbackURL: to,
        errorCallbackURL: "/sign-in-refused",
        disableRedirect: true,
      }),
    ),
    start,
  );
  const { url } = yield* Schema.decodeUnknownEffect(Started)(yield* started.json);
  // Straight to the way that is asked for: the provider would have a person choose one.
  let at = new URL(url.replace("/dex/auth?", `/dex/auth/${connector}?`));
  for (let step = 0; step < STEPS; step++) {
    if (at.origin === new URL(base).origin && !at.pathname.startsWith("/api/auth/")) {
      return { at: `${at.pathname}${at.search}`, cookie: carried(at) } satisfies Landed;
    }
    let answer = yield* send(HttpClientRequest.get(at), at);
    if (!REDIRECTS.includes(answer.status)) {
      // The provider's form, which is sent to where it was shown.
      answer = yield* send(
        HttpClientRequest.post(at).pipe(
          HttpClientRequest.bodyUrlParams({ login: email, password: Dex.PASSWORD }),
        ),
        at,
      );
    }
    const next = answer.headers["location"];
    if (next === undefined) {
      return yield* Effect.die(
        new Error(`${at.href} answered ${answer.status} and sent the browser nowhere`),
      );
    }
    at = new URL(next, at);
  }
  return yield* Effect.die(new Error(`signing in did not end within ${STEPS} steps`));
});
