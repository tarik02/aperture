import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { clientAddress, network } from "../src/http/client-address.ts";
import * as Control from "./src/control.ts";

const TOO_MANY = 429;
/** More than anyone is let try a password in a while. */
const TRIES = 8;
/** As many share links that are none as one address is let try in a while. */
const SHARE_TRIES = 30;

suite(Control.layer({ rateLimit: true }))(
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

    it.effect("share links that are none are counted by where they came from as well", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const http = yield* HttpClient.HttpClient;
        const tryFrom = (forwardedFor: string) =>
          http
            .execute(
              HttpClientRequest.post(
                `${control.url}/api/control/share/0198c0de-0000-7000-8000-000000000000`,
              ).pipe(
                HttpClientRequest.setHeader("x-forwarded-for", forwardedFor),
                HttpClientRequest.bodyJsonUnsafe({ token: "aps_a-guess" }),
              ),
            )
            .pipe(Effect.map((answer) => answer.status));

        const first = yield* Effect.forEach(Array.from({ length: SHARE_TRIES + 1 }), () =>
          tryFrom("203.0.113.20"),
        );
        expect(first.slice(0, SHARE_TRIES).every((status) => status === 401)).toBe(true);
        expect(first.at(-1)).toBe(TOO_MANY);
        expect(yield* tryFrom("203.0.113.21")).toBe(401);
      }),
    );

    it.effect("where a request came from is a trusted proxy's word, and nobody else's", () =>
      Effect.sync(() => {
        const trusted = ["127.0.0.0/8", "::1", "10.0.0.0/8", "fd00::/8", "2001:db8:aa::/48"].map(
          (named) => Result.getOrThrow(network(named)),
        );
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

        // Ranges of IPv6 are ranges too, and an address is one however it is written.
        expect(from("fd12:3456::1", "203.0.113.7")).toBe("203.0.113.7");
        expect(from("0:0:0:0:0:0:0:1", "203.0.113.7")).toBe("203.0.113.7");
        expect(from("2001:db8:aa:1::5", "2001:DB8:BB:0:0:0:0:1, fd00::2")).toBe("2001:db8:bb::1");
        expect(from("10.0.0.5", "203.0.113.7, ::ffff:10.1.2.3")).toBe("203.0.113.7");
        expect(from("2001:db8:ab::5", "203.0.113.7")).toBe("2001:db8:ab::5");
        expect(from("fe00::1", "203.0.113.7")).toBe("fe00::1");
        // What a proxy names that is no address is nobody the proxy is trusted for.
        expect(from("127.0.0.1", "203.0.113.7, unknown")).toBe("unknown");
        // A proxy of IPv4 that is named as IPv6 is the IPv4 one, alone or as a range.
        const mapped = ["::ffff:192.0.2.1", "::ffff:198.51.100.0/120"].map((named) =>
          Result.getOrThrow(network(named)),
        );
        const through = (remote: string) =>
          Option.getOrUndefined(clientAddress(mapped, Option.some(remote), "203.0.113.7"));
        expect(through("192.0.2.1")).toBe("203.0.113.7");
        expect(through("::ffff:198.51.100.200")).toBe("203.0.113.7");
        expect(through("192.0.2.2")).toBe("192.0.2.2");
        for (const named of ["10.0.0.0/33", "fd00::/129", "proxy.example", "10.0.0.1/"]) {
          expect(Result.isFailure(network(named)), named).toBe(true);
        }
      }),
    );
  },
);
