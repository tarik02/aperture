import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  aroundProxy,
  firstTab,
  iceCandidates,
  noOwnNetwork,
  reachesAroundProxy,
  STUN,
} from "../src/network.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";

/** A session whose browser has the network these arguments say. */
const sessionWith = (network: readonly string[]) =>
  Runner.layer({ features: ["cdp"], args: [...network, aroundProxy] });

const unmet = noOwnNetwork();
if (unmet !== undefined) {
  console.warn(`Checks of a browser with a network of its own are skipped: ${unmet}.`);
}
const withoutOwnNetwork = unmet !== undefined;

/** The title of a page that came through the session's proxy. */
const pageLoads = Effect.gen(function* () {
  const tab = yield* firstTab(yield* Runner.Runner);
  return yield* tab.open("https://example.com/");
});

/** The kinds of ICE candidates the page gathers; `srflx` where a STUN server answered. */
const candidates = Effect.gen(function* () {
  const tab = yield* firstTab(yield* Runner.Runner);
  return (yield* tab.evaluate(iceCandidates(STUN))) as string;
});

/** Whether the page reaches a site its browser was told not to ask the proxy for. */
const aroundTheProxy = Effect.gen(function* () {
  const tab = yield* firstTab(yield* Runner.Runner);
  return (yield* tab.evaluate(reachesAroundProxy)) as string;
});

suite(sessionWith([]))("a browser with proxied TCP and no UDP, as sessions have it", (it) => {
  it.effect("pages load", () =>
    Effect.gen(function* () {
      expect(yield* pageLoads).toBe("Example Domain");
    }),
  );

  it.effect("no TCP goes around the proxy", () =>
    Effect.gen(function* () {
      expect(yield* aroundTheProxy).toBe("refused");
    }),
  );

  it.effect("nothing goes out over UDP", () =>
    Effect.gen(function* () {
      expect(yield* candidates).not.toContain("srflx");
    }),
  );
});

suite(sessionWith(["--network-tcp", "direct", "--network-udp", "direct"]))(
  "a browser with direct TCP and direct UDP",
  (it) => {
    it.effect.skipIf(withoutOwnNetwork)(
      "the session starts and pages load, through the proxy",
      () =>
        Effect.gen(function* () {
          expect(yield* pageLoads).toBe("Example Domain");
        }),
    );

    it.effect.skipIf(withoutOwnNetwork)("a STUN server answers over UDP", () =>
      Effect.gen(function* () {
        expect(yield* candidates).toContain("srflx");
      }),
    );

    it.effect.skipIf(withoutOwnNetwork)("TCP goes around the proxy", () =>
      Effect.gen(function* () {
        expect(yield* aroundTheProxy).toBe("reached");
      }),
    );
  },
);

suite(sessionWith(["--network-udp", "direct"]))(
  "a browser with proxied TCP and direct UDP",
  (it) => {
    it.effect.skipIf(withoutOwnNetwork)(
      "the session starts and pages load, through the proxy",
      () =>
        Effect.gen(function* () {
          expect(yield* pageLoads).toBe("Example Domain");
        }),
    );

    it.effect.skipIf(withoutOwnNetwork)("a STUN server answers over UDP", () =>
      Effect.gen(function* () {
        expect(yield* candidates).toContain("srflx");
      }),
    );

    it.effect.skipIf(withoutOwnNetwork)("no TCP goes around the proxy", () =>
      Effect.gen(function* () {
        expect(yield* aroundTheProxy).toBe("refused");
      }),
    );
  },
);

suite(sessionWith(["--network-tcp", "direct"]))("a browser with direct TCP and no UDP", (it) => {
  it.effect.skipIf(withoutOwnNetwork)("pages load, through the proxy", () =>
    Effect.gen(function* () {
      expect(yield* pageLoads).toBe("Example Domain");
    }),
  );

  it.effect.skipIf(withoutOwnNetwork)("nothing goes out over UDP", () =>
    Effect.gen(function* () {
      expect(yield* candidates).not.toContain("srflx");
    }),
  );
});
