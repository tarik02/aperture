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

/** What the control plane answers someone who asks to be sent to a provider, as a status. */
export const askedThrough = Effect.fn("Control.askedThrough")(function* (
  base: string,
  provider: string,
) {
  const http = yield* HttpClient.HttpClient;
  const answer = yield* http.execute(
    HttpClientRequest.post(new URL("/api/auth/sign-in/social", base)).pipe(
      HttpClientRequest.setHeader("origin", new URL(base).origin),
      HttpClientRequest.bodyJsonUnsafe({ provider, callbackURL: "/", disableRedirect: true }),
    ),
  );
  return answer.status;
});

/**
 * Signs in through a provider as a browser does, without one: asks the control plane
 * where to go, goes where `first` makes of that, sends `form` to whatever the provider
 * shows in place of sending the browser on, and follows it back until the control plane
 * sends the browser to a page of the console.
 */
export const signInBy = Effect.fn("Control.signInBy")(function* (
  base: string,
  provider: string,
  to: string,
  first: (sent: string) => URL,
  form: Readonly<Record<string, string>>,
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
        provider,
        callbackURL: to,
        errorCallbackURL: "/sign-in-refused",
        disableRedirect: true,
      }),
    ),
    start,
  );
  const { url } = yield* Schema.decodeUnknownEffect(Started)(yield* started.json);
  let at = first(url);
  for (let step = 0; step < STEPS; step++) {
    if (at.origin === new URL(base).origin && !at.pathname.startsWith("/api/auth/")) {
      return { at: `${at.pathname}${at.search}`, cookie: carried(at) } satisfies Landed;
    }
    let answer = yield* send(HttpClientRequest.get(at), at);
    if (!REDIRECTS.includes(answer.status)) {
      // The provider's form, which is sent to where it was shown.
      answer = yield* send(
        HttpClientRequest.post(at).pipe(HttpClientRequest.bodyUrlParams(form)),
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

/**
 * Signs in through the suite's provider: gives it the email and the password at its form.
 */
export const signInThrough = Effect.fn("Control.signInThrough")(function* (
  base: string,
  connector: Dex.Connector,
  email: string,
  to = "/-/sessions",
  provider: string = Dex.PROVIDER,
) {
  return yield* signInBy(
    base,
    provider,
    to,
    // Straight to the way that is asked for: the provider would have a person choose one.
    (sent) => new URL(sent.replace("/dex/auth?", `/dex/auth/${connector}?`)),
    { login: email, password: Dex.PASSWORD },
  );
});
