import { Api } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { keepToken, token } from "./token.ts";

const client = (bearer: string) =>
  HttpApiClient.make(Api, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(bearer)),
  });

/** The control plane's API as whoever holds a token has it. */
export type Client = Effect.Success<ReturnType<typeof client>>;

/** What a call fails with: what the API says of it, or that it was not reached. */
export type Failure = { readonly _tag: string; readonly message?: string };

/**
 * One call of the API with a token, for what React waits on: it resolves with the answer
 * and rejects with what the API said instead.
 */
export const callAs = <A, E>(bearer: string, use: (client: Client) => Effect.Effect<A, E>) =>
  client(bearer).pipe(
    Effect.flatMap(use),
    Effect.provide(FetchHttpClient.layer),
    Effect.tapError((error) =>
      // A token that is nobody's any more signs nobody in.
      Effect.sync(() => {
        if ((error as Failure)._tag === "Unauthorized" && bearer === token()) {
          keepToken(undefined);
        }
      }),
    ),
    Effect.runPromise,
  );

/** One call with the token that is signed in with. */
export const call = <A, E>(use: (client: Client) => Effect.Effect<A, E>) =>
  callAs(token() ?? "", use);

/**
 * Has the browser carry the token to sessions' paths by itself, where a page cannot put
 * it on a request: the session's socket, a picture.
 */
export const carry = async (bearer: string) => {
  await fetch("/api/control/route/cookie", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
};

export const forget = async () => {
  await fetch("/api/control/route/cookie", { method: "DELETE" });
};

/** What a failed call says, in words for whoever reads the page. */
export const told = (error: unknown) => {
  const failure = error as Failure | null;
  if (failure !== null && typeof failure === "object" && typeof failure._tag === "string") {
    return failure.message ?? failure._tag;
  }
  return error instanceof Error ? error.message : "The control plane was not reached";
};
