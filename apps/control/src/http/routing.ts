import { PREFIX } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Accounts } from "../accounts/service.ts";
import { Forbidden, Unauthorized } from "../errors.ts";
import { bearerOf, callerOf, TOKEN_COOKIE } from "./caller.ts";
import { clientAddress } from "./client-address.ts";
import { guestOf, SHARE_COOKIE } from "./guest.ts";
import { nodePath } from "../routing/paths.ts";
import { ADMIT_PATH } from "../routing/layer.ts";
import { Routing } from "../routing/service.ts";
import { Settings } from "../settings/service.ts";
import { Shares } from "../shares/service.ts";

const COOKIE_PATH = `${PREFIX}/route/cookie`;
const PROXY_CONFIG_PATH = `${PREFIX}/route/traefik`;

const STATUS = {
  Unauthorized: 401,
  Forbidden: 403,
  SessionNotFound: 404,
  SessionHasNoNode: 409,
  SessionElsewhere: 409,
  ShareRefused: 401,
  TooManyTries: 429,
} as const;

const refused = (error: { readonly _tag: keyof typeof STATUS }) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe(error, { status: STATUS[error._tag] }));

/** What a proxy before the nodes asks of the control plane, and what a browser needs for it. */
export const layer = HttpRouter.use(
  Effect.fn(function* (router) {
    const accounts = yield* Accounts;
    const routing = yield* Routing;
    const settings = yield* Settings;
    const shares = yield* Shares;

    const admit = Effect.fn("Routing.http.admit")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      // The proxy asks with a request of its own, and says in this what it was asked.
      const uri = request.headers["x-forwarded-uri"] ?? "";
      const asCaller = Effect.flatMap(callerOf(accounts, request), (caller) =>
        routing.admit(caller, uri),
      );
      // Whoever reaches the session as themselves comes as themselves. A guest's link is
      // looked at for whom that lets into nothing, and gets them into its own session.
      // A link that carries a ticket of its own is whoever's was given it.
      const carried = yield* routing.admitTicket(uri, bearerOf(request));
      if (Option.isSome(carried)) {
        return HttpServerResponse.empty({ headers: { authorization: `Bearer ${carried.value}` } });
      }
      const ticket = yield* Option.match(guestOf(request, SHARE_COOKIE), {
        onNone: () => asCaller,
        onSome: (guest) =>
          Effect.catch(asCaller, (error) =>
            shares
              .admit(
                uri,
                guest,
                clientAddress(
                  settings.trustedProxies,
                  request.remoteAddress,
                  request.headers["x-forwarded-for"],
                ),
              )
              .pipe(
                // Who came as someone is told why that someone is not let in.
                Effect.mapError((asGuest) => (error._tag === "Unauthorized" ? asGuest : error)),
              ),
          ),
      });
      return HttpServerResponse.empty({ headers: { authorization: `Bearer ${ticket}` } });
    }, Effect.catch(refused));

    const keep = Effect.fn("Routing.http.keep")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const given = yield* Option.match(bearerOf(request), {
        onNone: () => Effect.fail(new Unauthorized({ message: "the request carries no token" })),
        onSome: Effect.succeed,
      });
      yield* accounts.identify(given);
      return yield* HttpServerResponse.empty().pipe(
        HttpServerResponse.setCookie(TOKEN_COOKIE, given, {
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
        HttpServerResponse.setCookie(TOKEN_COOKIE, "", { path: nodePath(""), maxAge: 0 }),
        Effect.orDie,
      );

    const proxyConfig = Effect.fn("Routing.http.proxyConfig")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const asProxy = Option.match(bearerOf(request), {
        onNone: () => false,
        onSome: (bearer) =>
          Option.exists(settings.proxyToken, (token) => Redacted.value(token) === bearer),
      });
      if (!asProxy && !(yield* callerOf(accounts, request)).admin) {
        return yield* new Forbidden({ message: "the routes are a proxy's or an admin's to read" });
      }
      return HttpServerResponse.jsonUnsafe(yield* routing.proxyConfig());
    }, Effect.catch(refused));

    yield* router.add("GET", ADMIT_PATH, admit);
    yield* router.add("POST", COOKIE_PATH, keep);
    yield* router.add("DELETE", COOKIE_PATH, forget);
    yield* router.add("GET", PROXY_CONFIG_PATH, proxyConfig);
  }),
);
