import * as Cookies from "effect/http/Cookies";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Control from "./control.ts";

const PASSWORD = "a password of the checks' own";

/** The cookies an answer sets, as a browser sends them back; what it takes back is left out. */
export const cookiesOf = (answer: HttpClientResponse.HttpClientResponse) =>
  Object.entries(Cookies.toRecord(answer.cookies))
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

/** A person with an account, signed in: the cookies their browser carries, and the password. */
export const signedIn = Effect.fn("Control.signedIn")(function* (name: string, email: string) {
  const control = yield* Control.Control;
  const http = yield* HttpClient.HttpClient;
  const bootstrap = yield* control.as(control.bootstrapToken);
  const account = yield* bootstrap.accounts.create({ payload: { name, email } });
  const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: account.id } });
  const post = (path: string, body: object) =>
    http.execute(
      HttpClientRequest.post(`${control.url}${path}`).pipe(
        HttpClientRequest.setHeader("origin", control.url),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
  yield* post("/api/auth/reset-password", { token, newPassword: PASSWORD });
  const answer = yield* post("/api/auth/sign-in/email", { email, password: PASSWORD });
  return { account, email, password: PASSWORD, cookie: cookiesOf(answer) };
});
