import { PREFIX } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { Accounts } from "../accounts/service.ts";
import { Forbidden, Unauthorized } from "../errors.ts";
import { nodePath } from "../routing/paths.ts";
import { ADMIT_PATH } from "../routing/layer.ts";
import { Routing } from "../routing/service.ts";

/**
 * Carries an account's API token for a browser, which cannot put one on the requests a
 * page makes by itself: a picture, a socket. It is sent to sessions' paths and nowhere
 * else, so nothing is done in the API by a page that merely has it.
 */
const COOKIE = "aperture_control";
const COOKIE_PATH = `${PREFIX}/route/cookie`;
const PROXY_CONFIG_PATH = `${PREFIX}/route/traefik`;

const STATUS = {
  Unauthorized: 401,
  Forbidden: 403,
  SessionNotFound: 404,
  SessionHasNoNode: 409,
  SessionElsewhere: 409,
} as const;

const BEARER = /^Bearer\s+(.+)$/iu;

const bearer = (request: HttpServerRequest.HttpServerRequest) =>
  Option.fromUndefinedOr(BEARER.exec(request.headers["authorization"] ?? "")?.[1]);

/** The token a request carries: as an API's caller sends one, or as a browser does. */
const token = (request: HttpServerRequest.HttpServerRequest) =>
  bearer(request).pipe(
    Option.orElse(() => Option.fromUndefinedOr(request.cookies[COOKIE])),
    Option.match({
      onNone: () => Effect.fail(new Unauthorized({ message: "the request carries no token" })),
      onSome: Effect.succeed,
    }),
  );

const refused = (error: { readonly _tag: keyof typeof STATUS }) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe(error, { status: STATUS[error._tag] }));

/** What a proxy before the nodes asks of the control plane, and what a browser needs for it. */
export const layer = HttpRouter.use(
  Effect.fn(function* (router) {
    const accounts = yield* Accounts;
    const routing = yield* Routing;

    const admit = Effect.fn("Routing.http.admit")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const caller = yield* accounts.identify(yield* token(request));
      // The proxy asks with a request of its own, and says in this what it was asked.
      const ticket = yield* routing.admit(caller, request.headers["x-forwarded-uri"] ?? "");
      return HttpServerResponse.empty({ headers: { authorization: `Bearer ${ticket}` } });
    }, Effect.catch(refused));

    const keep = Effect.fn("Routing.http.keep")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const given = yield* Option.match(bearer(request), {
        onNone: () => Effect.fail(new Unauthorized({ message: "the request carries no token" })),
        onSome: Effect.succeed,
      });
      yield* accounts.identify(given);
      return yield* HttpServerResponse.empty().pipe(
        HttpServerResponse.setCookie(COOKIE, given, {
          httpOnly: true,
          sameSite: "strict",
          secure: request.headers["x-forwarded-proto"] === "https",
          path: nodePath(""),
        }),
        Effect.orDie,
      );
    }, Effect.catch(refused));

    const forget = () =>
      HttpServerResponse.empty().pipe(
        HttpServerResponse.setCookie(COOKIE, "", { path: nodePath(""), maxAge: 0 }),
        Effect.orDie,
      );

    const proxyConfig = Effect.fn("Routing.http.proxyConfig")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const caller = yield* accounts.identify(yield* token(request));
      if (!caller.admin) {
        return yield* new Forbidden({ message: "the routes are an admin's to read" });
      }
      return HttpServerResponse.jsonUnsafe(yield* routing.proxyConfig());
    }, Effect.catch(refused));

    yield* router.add("GET", ADMIT_PATH, admit);
    yield* router.add("POST", COOKIE_PATH, keep);
    yield* router.add("DELETE", COOKIE_PATH, forget);
    yield* router.add("GET", PROXY_CONFIG_PATH, proxyConfig);
  }),
);
