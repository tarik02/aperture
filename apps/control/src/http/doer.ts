import type { EventActor } from "@aperture-browser/control-api";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import type { DoerShape } from "../events/doer.ts";
import type { SettingsShape } from "../settings/service.ts";
import { clientAddress } from "./client-address.ts";

/** Who does what a request asks for, with where the request came from. */
export const doing = (
  settings: SettingsShape,
  request: HttpServerRequest.HttpServerRequest,
  actor: EventActor,
): DoerShape => ({
  actor,
  address: Option.getOrNull(
    clientAddress(
      settings.trustedProxies,
      request.remoteAddress,
      request.headers["x-forwarded-for"],
    ),
  ),
});
