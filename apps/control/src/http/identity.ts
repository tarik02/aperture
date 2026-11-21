import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Identity } from "../identity/service.ts";
import { Settings } from "../settings/service.ts";
import { clientAddress } from "./client-address.ts";

/** What signs people in and out, at its own routes. */
export const layer = HttpRouter.use(
  Effect.fn(function* (router) {
    const identity = yield* Identity;
    const settings = yield* Settings;
    yield* router.add(
      "*",
      `${identity.path}/*`,
      Effect.fn("Identity.http")(function* (request: HttpServerRequest.HttpServerRequest) {
        const asked = yield* Effect.orDie(HttpServerRequest.toWeb(request));
        const from = clientAddress(
          settings.trustedProxies,
          request.remoteAddress,
          request.headers["x-forwarded-for"],
        );
        return HttpServerResponse.fromWeb(yield* identity.handle(asked, from));
      }),
    );
  }),
);
