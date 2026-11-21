import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import type { AccountsShape } from "../accounts/service.ts";

const BEARER = /^Bearer\s+(.+)$/iu;

/**
 * Carries an account's API token for a browser, which cannot put one on the requests a
 * page makes by itself: a picture, a socket. It is sent to sessions' paths and nowhere
 * else, so nothing is done in the API by a page that merely has it.
 */
export const TOKEN_COOKIE = "aperture_control";

/** The API token a request carries as a caller of the API sends one. */
export const bearerOf = (request: HttpServerRequest.HttpServerRequest) =>
  Option.fromUndefinedOr(BEARER.exec(request.headers["authorization"] ?? "")?.[1]);

/**
 * Who a request comes from: whoever its API token is of, as a caller of the API sends one
 * or as a browser was given one to carry, and otherwise whoever its cookies sign in.
 */
export const callerOf = (accounts: AccountsShape, request: HttpServerRequest.HttpServerRequest) =>
  bearerOf(request).pipe(
    Option.orElse(() => Option.fromUndefinedOr(request.cookies[TOKEN_COOKIE])),
    Option.match({
      onSome: accounts.identify,
      onNone: () => accounts.ofPerson(new Headers(request.headers)),
    }),
    Effect.withSpan("callerOf"),
  );
