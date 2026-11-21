import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  addressOf,
  aroundProxy,
  firstTab,
  iceCandidates,
  lacksOwnNetwork,
  reachesAroundProxy,
  STUN,
} from "../src/network.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { platform, suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

/** A server on this machine that speaks no TLS, as a developer runs one. */
interface DevServerService {
  readonly port: number;
  /** The names it was asked for, as the `Host` of each request told them. */
  readonly hosts: () => readonly string[];
}

class DevServer extends Context.Service<DevServer, DevServerService>()(
  "@aperture-browser/e2e/names/DevServer",
) {}

const DEV_SERVER_TITLE = "dev server";

const devServer = Layer.effect(
  DevServer,
  Effect.gen(function* () {
    const hosts: string[] = [];
    const page = Site.html(`<title>${DEV_SERVER_TITLE}</title>hello`);
    const site = yield* Site.serve(
      Site.by((request) => {
        hosts.push(request.headers["host"] ?? "");
        return page;
      }),
    );
    return { port: site.port, hosts: () => hosts };
  }),
);

/** A session that reaches the dev server, whose browser has the network these arguments say. */
const sessionWith = (network: readonly string[]) =>
  Layer.mergeAll(
    Runner.layer({
      features: ["cdp"],
      args: ["--egress-allow", "127.0.0.1", ...network, aroundProxy],
    }),
    devServer,
  );

/**
 * Records for the dev server and for a STUN server under names nobody else knows, and a
 * rule that has the session answer the TLS of a third name and pass it on to the dev server.
 */
const configuration = Effect.gen(function* () {
  const server = yield* DevServer;
  const stun = yield* addressOf(STUN);
  return {
    rules: [{ match: "secure.test", via: "direct", to: `127.0.0.1:${server.port}`, tls: true }],
    dns: {
      records: [
        { name: "app.test", addresses: ["127.0.0.1"] },
        { name: "*.stun.test", addresses: [stun] },
      ],
    },
  };
});

/** Gives the session a proxy configuration; the answer tells whether it took it. */
const configure = (config: object) =>
  Effect.gen(function* () {
    const runner = yield* Runner.Runner;
    return yield* runner.request("PUT", "/proxy", config);
  });

/** Goes to an address in the session's first tab; the title of what is there. */
const open = (url: string) =>
  Effect.gen(function* () {
    const tab = yield* firstTab(yield* Runner.Runner);
    return yield* tab.open(url);
  });

/** Evaluates in the page the session's first tab shows. */
const inPage = (expression: string) =>
  Effect.gen(function* () {
    const tab = yield* firstTab(yield* Runner.Runner);
    return yield* tab.evaluate(expression);
  });

const withoutOwnNetwork = await Effect.runPromise(lacksOwnNetwork.pipe(Effect.provide(platform)));

suite(sessionWith([]))("names, records and TLS the session answers", (it) => {
  it.effect("a configuration with records and a rule that answers TLS is taken", () =>
    Effect.gen(function* () {
      const taken = yield* configure(yield* configuration);
      expect(taken.status, JSON.stringify(taken.body)).toBe(204);
    }),
  );

  it.effect("a record names where a page is", () =>
    Effect.gen(function* () {
      const server = yield* DevServer;
      expect(yield* open(`http://app.test:${server.port}/`)).toBe(DEV_SERVER_TITLE);
    }),
  );

  it.effect("a server that speaks no TLS is https to the page", () =>
    Effect.gen(function* () {
      expect(yield* open("https://secure.test/")).toBe(DEV_SERVER_TITLE);
      expect(yield* inPage("isSecureContext")).toBe(true);
      expect(yield* inPage("location.protocol")).toBe("https:");
    }),
  );

  it.effect("the server was asked for the name the page has", () =>
    Effect.gen(function* () {
      const server = yield* DevServer;
      expect(server.hosts()).toContain("secure.test");
    }),
  );

  it.effect("a rule that answers TLS leaves the name's plain port alone", () =>
    Effect.gen(function* () {
      const server = yield* DevServer;
      const asked = server.hosts().length;
      // The rule is for port 443, and no record says where the name is.
      expect(yield* open(`http://secure.test:${server.port}/`)).not.toBe(DEV_SERVER_TITLE);
      expect(server.hosts().length).toBe(asked);
    }),
  );

  it.effect("other sites keep their own certificates", () =>
    Effect.gen(function* () {
      expect(yield* open("https://example.com/")).toBe("Example Domain");
    }),
  );

  it.effect("a name no rule covers is not answered with the session's certificate", () =>
    Effect.gen(function* () {
      expect(yield* open("https://other.test/")).not.toBe(DEV_SERVER_TITLE);
    }),
  );

  it.effect("resolvers that do not answer leave names unresolved", () =>
    Effect.gen(function* () {
      const taken = yield* configure({ dns: { servers: ["192.0.2.1"] } });
      expect(taken.status, JSON.stringify(taken.body)).toBe(204);
      expect(yield* open("http://example.net/")).not.toBe("Example Domain");
    }),
  );

  it.effect("resolvers the session names are asked", () =>
    Effect.gen(function* () {
      const taken = yield* configure({ dns: { servers: ["1.1.1.1"] } });
      expect(taken.status, JSON.stringify(taken.body)).toBe(204);
      expect(yield* open("http://example.net/")).toBe("Example Domain");
    }),
  );

  it.effect("a resolver local to the node is refused", () =>
    Effect.gen(function* () {
      const refused = yield* configure({ dns: { servers: ["10.0.0.1"] } });
      expect(refused.status).toBe(400);
    }),
  );

  it.effect("a rule that refuses connections answers no TLS", () =>
    Effect.gen(function* () {
      const refused = yield* configure({
        rules: [{ match: "x.test", via: "refuse", tls: true }],
      });
      expect(refused.status).toBe(400);
    }),
  );
});

/**
 * The kinds of ICE candidates the page gathers with a STUN server, asked again when none
 * came through it: the server is someone else's, on the internet, and now and then silent.
 */
const throughStun = (server: string) => {
  const kinds = inPage(iceCandidates(server)).pipe(Effect.map(String));
  return until(
    `a candidate through ${server}`,
    kinds.pipe(Effect.map((told) => told.includes("srflx") && told)),
    "40 seconds",
  ).pipe(Effect.catch(() => kinds));
};

suite(sessionWith(["--network-udp", "direct"]))("names, for a browser with direct UDP", (it) => {
  it.effect.skipIf(withoutOwnNetwork)("the browser's own names are resolved", () =>
    Effect.gen(function* () {
      const taken = yield* configure(yield* configuration);
      expect(taken.status, JSON.stringify(taken.body)).toBe(204);
      expect(yield* throughStun(STUN)).toContain("srflx");
    }),
  );

  it.effect.skipIf(withoutOwnNetwork)("the browser's own names go by the session's records", () =>
    Effect.gen(function* () {
      expect(yield* throughStun("one.stun.test")).toContain("srflx");
    }),
  );

  it.effect.skipIf(withoutOwnNetwork)("pages still load, by the session's rules", () =>
    Effect.gen(function* () {
      expect(yield* open("https://secure.test/")).toBe(DEV_SERVER_TITLE);
    }),
  );
});

suite(sessionWith(["--network-tcp", "direct"]))("names, for a browser with direct TCP", (it) => {
  it.effect.skipIf(withoutOwnNetwork)("names resolve for what goes around the proxy", () =>
    Effect.gen(function* () {
      yield* open("https://example.com/");
      expect(yield* inPage(reachesAroundProxy)).toBe("reached");
    }),
  );
});
