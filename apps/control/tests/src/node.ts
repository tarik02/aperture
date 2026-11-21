import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Control from "./control.ts";

export const NODE = "node-a";
const KEEPALIVE_EVERY = "500 millis";

/** The node's keepalives, which the checks send in the executor's place. */
export class Keepalives extends Context.Service<
  Keepalives,
  {
    /** Stops them, as a node that died or lost its way to the control plane. */
    readonly stop: Effect.Effect<void>;
    readonly start: Effect.Effect<void>;
  }
>()("@aperture-browser/control/tests/Keepalives") {}

const node = Layer.effect(
  Executor.Executor,
  Effect.gen(function* () {
    const control = yield* Control.Control;
    return yield* Executor.start({
      features: ["mcp", "cdp", "recordings"],
      env: { APERTURE_TICKET_KEY: control.ticketKey },
    });
  }),
);

const keepalives = Layer.effect(
  Keepalives,
  Effect.gen(function* () {
    const control = yield* Control.Control;
    const executor = yield* Executor.Executor;
    const bootstrap = yield* control.as(control.bootstrapToken);
    const token = yield* bootstrap.nodes.createRegistrationToken({ payload: { name: "checks" } });
    let sending = true;
    yield* Effect.suspend(() =>
      sending
        ? control.keepalive({
            registrationToken: token.token,
            name: NODE,
            internalUrl: executor.url,
            publicUrl: executor.url,
            operatorToken: executor.token,
          })
        : Effect.void,
    ).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(KEEPALIVE_EVERY)), Effect.forkScoped);
    yield* until(
      "the control plane reaching the node",
      bootstrap.nodes
        .list()
        .pipe(Effect.map((nodes) => nodes.some((listed) => listed.offers !== null))),
    );
    return {
      stop: Effect.sync(() => {
        sending = false;
      }),
      start: Effect.sync(() => {
        sending = true;
      }),
    };
  }),
);

/** A real executor that is a node of the suite's control plane, kept alive by the checks. */
export const registered = keepalives.pipe(Layer.provideMerge(node));
