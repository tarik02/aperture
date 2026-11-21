import * as HttpMiddleware from "effect/http/HttpMiddleware";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import type { SettingsShape } from "../settings/service.ts";

const PREFLIGHT_LASTS_SECONDS = 86_400;

/**
 * Lets a page of any origin call: an app that runs in a browser is one too. What is
 * called so takes no cookies and is answered without leave to send any, so a page gets
 * nothing by it that it would not get from anywhere else.
 */
export const anyOrigin = (exposedHeaders: ReadonlyArray<string> = []) =>
  HttpMiddleware.cors({
    allowedMethods: ["GET", "POST"],
    exposedHeaders,
    maxAge: PREFLIGHT_LASTS_SECONDS,
  });

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
