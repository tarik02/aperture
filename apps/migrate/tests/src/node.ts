import * as Control from "@aperture-browser/control/tests/src/control.ts";
import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

export const NODE = "node-a";
const KEEPALIVE_EVERY = "500 millis";

const node = Layer.effect(
  Executor.Executor,
  Effect.gen(function* () {
    const control = yield* Control.Control;
    return yield* Executor.start({
      features: ["cdp"],
      env: {
        APERTURE_TICKET_KEY: control.ticketKey,
        // The site the migrated browser is signed in to is on this machine.
        APERTURE_EGRESS_ALLOW: "127.0.0.1",
      },
    });
  }),
);

const keepalives = Layer.effectDiscard(
  Effect.gen(function* () {
    const control = yield* Control.Control;
    const executor = yield* Executor.Executor;
    const bootstrap = yield* control.as(control.bootstrapToken);
    const token = yield* bootstrap.nodes.createRegistrationToken({ payload: { name: "checks" } });
    yield* control
      .keepalive({
        registrationToken: token.token,
        name: NODE,
        internalUrl: executor.url,
        publicUrl: executor.url,
        operatorToken: executor.token,
      })
      .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(KEEPALIVE_EVERY)), Effect.forkScoped);
    yield* until(
      "the control plane reaching the node",
      bootstrap.nodes
        .list()
        .pipe(Effect.map((nodes) => nodes.some((listed) => listed.offers !== null))),
    );
  }),
);

/** A real executor that is a node of the suite's control plane, kept alive by the checks. */
export const registered = keepalives.pipe(Layer.provideMerge(node));
