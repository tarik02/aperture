import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Control from "./src/control.ts";

suite(Control.layer({ console: true }))("how a browser is to take what is answered", (it) => {
  it.effect("the console's pages and the API say what they are, and stand in no frame", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      for (const path of ["/", "/-/sessions", "/api/control/health", "/api/control/sessions"]) {
        const { headers } = yield* http.get(`${control.url}${path}`);
        expect([path, headers["x-content-type-options"]]).toEqual([path, "nosniff"]);
        expect([path, headers["referrer-policy"]]).toEqual([path, "no-referrer"]);
        expect([path, headers["x-frame-options"]]).toEqual([path, "DENY"]);
        const policy = headers["content-security-policy"] ?? "";
        expect(policy).toContain("frame-ancestors 'none'");
        expect(policy).toContain("script-src 'self';");
      }
    }),
  );
});
