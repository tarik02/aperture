import { Api } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { refusedHere, signChanged } from "#/lib/sign.ts";
import { keepToken, token } from "#/lib/token.ts";
import { sentence } from "#/lib/words.ts";

/** With no token, the browser's cookies say who asks: those of someone who signed in. */
const client = (bearer: string | undefined) =>
  HttpApiClient.make(
    Api,
    bearer === undefined
      ? {}
      : { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(bearer)) },
  );

/** The control plane's API as whoever holds a token has it. */
export type Client = Effect.Success<ReturnType<typeof client>>;

/** What a call fails with, as the API tells it. */
export interface Failure {
  readonly _tag: string;
  readonly message?: string;
}

export const isFailure = (error: unknown): error is Failure =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string";

/**
 * One call of the API with a token, for what React waits on: it resolves with the answer
 * and rejects with what the API said instead.
 */
export const callAs = <A, E>(
  bearer: string | undefined,
  use: (client: Client) => Effect.Effect<A, E>,
) =>
  client(bearer).pipe(
    Effect.flatMap(use),
    Effect.provide(FetchHttpClient.layer),
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (!isFailure(error) || error._tag !== "Unauthorized" || bearer !== token()) {
          return;
        }
        if (bearer === undefined) {
          // The cookies sign nobody in any more: signed out in another tab, or run out.
          refusedHere();
        } else {
          // A token that is nobody's any more signs nobody in. The other tabs hear of it
          // from what the browser keeps.
          keepToken(undefined);
          signChanged();
        }
      }),
    ),
    Effect.runPromise,
  );

/** One call with the token that is signed in with. */
export const call = <A, E>(use: (client: Client) => Effect.Effect<A, E>) => callAs(token(), use);

const COOKIE = "/api/control/route/cookie";

/**
 * Has the browser carry the token to sessions' paths by itself, where a page cannot put
 * it on a request: the session's socket, a picture.
 */
export const carry = async (bearer: string) => {
  await fetch(COOKIE, { method: "POST", headers: { Authorization: `Bearer ${bearer}` } });
};

export const forget = async () => {
  await fetch(COOKIE, { method: "DELETE" });
};

/** What each failure says where the API gave it no words of its own. */
const SAID: Readonly<Record<string, string>> = {
  Unauthorized: "You are not signed in.",
  Forbidden: "You are not allowed to do this.",
  AccountNotFound: "There is no such account.",
  SessionNotFound: "This session does not exist. It may have been deleted.",
  NoNode: "No node is there to run the session on.",
  SessionHasNoNode: "This session is on no node.",
  NodeUnreachable: "The session's node is out of reach.",
  NodeRefused: "The session's node refused.",
  SnapshotNotFound: "This snapshot does not exist. It may have been deleted.",
  SessionElsewhere: "This session is on another node now.",
  ApiTokenNotFound: "There is no such API token.",
  RegistrationTokenNotFound: "There is no such registration token.",
  WorkspaceNotFound: "There is no such workspace.",
  WorkspaceInUse: "The workspace still has sessions or snapshots.",
  EmailTaken: "Someone has this email address already.",
  PersonNotFound: "There is no such person.",
  AccountInvalid: "The account cannot be as asked.",
  AccountInUse: "The account still has sessions or snapshots of its own.",
  OAuthClientNotFound: "There is no such app.",
  RedirectRefused: "The app may not be sent back to that address.",
  GrantNotFound: "This app is not connected any more.",
  ShareNotFound: "There is no such share link.",
  ShareRefused: "This share link lets nobody in.",
  TooManyTries: "Too many tries. Try again later.",
  SettingInvalid: "The setting does not take that.",
  SettingOutOfBounds: "A level above does not let the setting be that.",
  QuotaExceeded: "There are as many as there may be already.",
  // What the client itself fails with, before or after the API answered.
  HttpClientError: "The control plane was not reached. Check the connection and try again.",
  RequestError: "The control plane was not reached. Check the connection and try again.",
  ResponseError: "The control plane gave an answer that was not understood.",
  HttpApiDecodeError: "What was sent is not what the control plane takes.",
  HttpApiSchemaError: "What was sent is not what the control plane takes.",
  ParseError: "The control plane gave an answer that was not understood.",
  SchemaError: "The control plane gave an answer that was not understood.",
};

/** Words of a program for a program: an address, a place in what was sent. */
const RAW = /^Transport error|^StatusCode|^Decode error|^Expected |\bat \[|^\{/u;

/** What a failed call says, in words for whoever reads the page: never nothing. */
export const told = (error: unknown, fallback = "The control plane was not reached") => {
  const said = isFailure(error) || error instanceof Error ? (error.message ?? "").trim() : "";
  if (said !== "" && !RAW.test(said)) {
    return sentence(said);
  }
  return sentence(isFailure(error) ? (SAID[error._tag] ?? fallback) : fallback);
};
