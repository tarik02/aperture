import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ExecutorService } from "./executor.ts";

/** A site nobody visits, whose cookies are the checks' own. */
const SITE = "example.test";

const KEPT_SECONDS = 24 * 60 * 60;

const Cookies = Schema.Struct({
  cookies: Schema.Array(Schema.Struct({ name: Schema.String, domain: Schema.String })),
});

/**
 * Leaves a cookie of this name in the profile of a session's browser. Cookies are how a
 * check tells what a profile went through: each step it took leaves one.
 */
export const leaveCookie = (node: ExecutorService, sessionId: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cdp = yield* node.cdp(sessionId);
      const now = yield* Clock.currentTimeMillis;
      yield* cdp.call("Storage.setCookies", {
        cookies: [
          {
            name,
            value: "1",
            domain: SITE,
            path: "/",
            // A cookie that does not expire is the browser session's, and is not kept.
            expires: now / 1000 + KEPT_SECONDS,
          },
        ],
      });
    }),
  );

/** The names of the cookies checks left in the profile of a session's browser, in order. */
export const cookiesLeft = (node: ExecutorService, sessionId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cdp = yield* node.cdp(sessionId);
      const { cookies } = yield* cdp.call("Storage.getCookies", {}, Cookies);
      return cookies
        .filter((cookie) => cookie.domain === SITE)
        .map((cookie) => cookie.name)
        .sort();
    }),
  );
