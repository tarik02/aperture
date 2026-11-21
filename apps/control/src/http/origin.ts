import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import type { SettingsShape } from "../settings/service.ts";

/**
 * Where people and apps reach this program, for the addresses it tells them: what the
 * settings say, and without that what the request says it came to.
 */
export const originOf = (settings: SettingsShape, request: HttpServerRequest.HttpServerRequest) =>
  Option.match(settings.publicUrl, {
    onSome: (url) => new URL(url).origin,
    onNone: () => {
      const scheme = request.headers["x-forwarded-proto"] ?? "http";
      const host = request.headers["x-forwarded-host"] ?? request.headers["host"] ?? "localhost";
      return `${scheme}://${host}`;
    },
  });
