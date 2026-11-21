import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import { clientAddress } from "../src/http/client-address.ts";
import * as Control from "./src/control.ts";

const TOO_MANY = 429;
/** More than anyone is let try a password in a while. */
const TRIES = 8;

suite(Control.layer({ stores: "memory", rateLimit: true }))(
  "signing in, held to so many tries from one address",
  (it) => {
    it.effect("tries are counted by where a trusted proxy says they came from", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const http = yield* HttpClient.HttpClient;
        // The checks reach the control plane from this machine, which it trusts as a proxy.
        const tryFrom = (forwardedFor: string) =>
          http
            .execute(
              HttpClientRequest.post(`${control.url}/api/auth/sign-in/email`).pipe(
                HttpClientRequest.setHeader("origin", control.url),
                HttpClientRequest.setHeader("x-forwarded-for", forwardedFor),
                // Nobody says this but the control plane itself.
                HttpClientRequest.setHeader("x-aperture-client-address", "198.51.100.200"),
                HttpClientRequest.bodyJsonUnsafe({
                  email: "nobody@example.test",
                  password: "wrong",
                }),
              ),
            )
            .pipe(Effect.map((answer) => answer.status));

        const first = yield* Effect.forEach(Array.from({ length: TRIES }), () =>
          tryFrom("203.0.113.7"),
        );
        expect(first.at(0)).not.toBe(TOO_MANY);
        expect(first.at(-1)).toBe(TOO_MANY);
        // Another address has tries of its own, though it came through the same proxy.
        expect(yield* tryFrom("203.0.113.8")).not.toBe(TOO_MANY);
        // What an address says of proxies before it is its own word, and is not taken.
        expect(yield* tryFrom("198.51.100.1, 203.0.113.7")).toBe(TOO_MANY);
      }),
    );

    it.effect("where a request came from is a trusted proxy's word, and nobody else's", () =>
      Effect.sync(() => {
        const trusted = ["127.0.0.0/8", "::1", "10.0.0.0/8"];
        const from = (remote: string, forwardedFor?: string) =>
          Option.getOrUndefined(clientAddress(trusted, Option.some(remote), forwardedFor));

        expect(from("127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
        expect(from("::ffff:127.0.0.1", "203.0.113.7")).toBe("203.0.113.7");
        expect(from("::1", "203.0.113.7, 10.1.2.3")).toBe("203.0.113.7");
        // The last that is no proxy: what is before it is only what it said.
        expect(from("10.0.0.5", "198.51.100.1, 203.0.113.7, 10.9.9.9")).toBe("203.0.113.7");
        // Not a proxy: it came from where its connection did, whatever it says.
        expect(from("203.0.113.9", "198.51.100.1")).toBe("203.0.113.9");
        expect(from("11.0.0.1", "198.51.100.1")).toBe("11.0.0.1");
        // A proxy that says nothing is where it came from.
        expect(from("127.0.0.1")).toBe("127.0.0.1");
        expect(Option.isNone(clientAddress(trusted, Option.none(), "203.0.113.7"))).toBe(true);
      }),
    );
  },
);
