import { proto } from "@aperture-browser/executor-client";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Executor from "../src/executor.ts";
import * as Files from "../src/files.ts";
import { refusal } from "../src/http.ts";
import { suite } from "../src/suite.ts";

/** What a runner is started with, as the executor writes it for the runner to read. */
const Spec = Schema.Struct({
  features: Schema.Record(Schema.String, Schema.Boolean),
  network: Schema.Struct({ udp: Schema.String }),
});

const oneNode = Executor.layer({
  features: ["sound", "cdp", "mcp"],
  env: { APERTURE_NETWORK_UDP: "direct" },
});

/** Features by their names, in order, so that a check reads as what is offered. */
const offered = (features: readonly proto.Feature[]) =>
  features.map((feature) => proto.Feature[feature]).sort();

suite(oneNode)("what a session asks for itself, within what its executor has", (it) => {
  let node: Executor.ExecutorService;
  let all: proto.Session;
  let few: proto.Session;

  it.effect("the executor says what its sessions may have", () =>
    Effect.gen(function* () {
      node = yield* Executor.Executor;
      const executor = yield* node.client.get;
      expect(offered(executor.features)).toEqual(["CDP", "MCP", "SOUND"]);
      expect(executor.network?.udp).toBe(proto.NetworkUdp.DIRECT);
      expect(executor.holdsResources).toBe(false);
    }),
  );

  it.effect("a session that says nothing offers what the executor does, on its network", () =>
    Effect.gen(function* () {
      all = yield* node.client.sessions.create();
      expect(offered(all.features)).toEqual(["CDP", "MCP", "SOUND"]);
      expect(all.network?.tcp).toBe(proto.NetworkTcp.PROXIED);
      expect(all.network?.udp).toBe(proto.NetworkUdp.DIRECT);

      const devtools = yield* node.session(all.id, "GET", "/cdp/json/version");
      expect(devtools.status).toBe(200);
    }),
  );

  it.effect("a session offers only the features it says, on the network it says", () =>
    Effect.gen(function* () {
      few = yield* node.client.sessions.create({
        features: { on: [proto.Feature.SOUND] },
        network: { udp: proto.NetworkUdp.NONE },
      });
      expect(offered(few.features)).toEqual(["SOUND"]);
      expect(few.network?.udp).toBe(proto.NetworkUdp.NONE);

      const devtools = yield* node.session(few.id, "GET", "/cdp/json/version");
      expect(devtools.status).not.toBe(200);
    }),
  );

  it.effect("its runner is started with those and nothing else", () =>
    Effect.gen(function* () {
      const spec = yield* Files.json(`${node.runtime}/${few.id}/spec.json`, Spec);
      expect(spec.features["sound"]).toBe(true);
      expect(spec.features["cdp"]).toBe(false);
      expect(spec.network.udp).toBe("none");
    }),
  );

  it.effect("a session may offer nothing", () =>
    Effect.gen(function* () {
      const none = yield* node.client.sessions.create({ features: {}, suspended: true });
      expect(none.features).toEqual([]);
    }),
  );

  it.effect("a feature the executor has not is refused", () =>
    Effect.gen(function* () {
      const refused = yield* node.rpc("CreateSession", { features: { on: ["FEATURE_TUNNEL"] } });
      expect(refused.status).toBe(400);
      expect((yield* refusal(refused)).code).toBe("failed_precondition");
    }),
  );

  it.effect("a network the executor has not is refused", () =>
    Effect.gen(function* () {
      const refused = yield* node.rpc("CreateSession", { network: { tcp: "NETWORK_TCP_DIRECT" } });
      expect(refused.status).toBe(400);
      expect((yield* refusal(refused)).code).toBe("failed_precondition");
    }),
  );

  it.effect("a session resumed on an executor that offers less offers less", () =>
    Effect.gen(function* () {
      yield* node.client.sessions.suspend(all.id);
      yield* node.client.sessions.suspend(few.id);
      // An executor that offers less takes the place of the one that offered more.
      yield* node.restart({ features: ["sound"] });

      const resumed = yield* node.client.sessions.resume(all.id);
      expect(offered(resumed.features)).toEqual(["SOUND"]);
      expect(resumed.network?.udp).toBe(proto.NetworkUdp.NONE);
    }),
  );
});
