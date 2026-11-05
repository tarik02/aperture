import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import {
  getWindowControlsOverlay,
  windowControlsOverlayClasses,
} from "#/features/window-controls-overlay/window-controls-overlay.ts";

export interface WindowControlsOverlayShape {
  /** The WCO classes for the current window geometry, including the latest value. */
  readonly changes: Stream.Stream<readonly string[]>;
}

export class WindowControlsOverlay extends Context.Service<
  WindowControlsOverlay,
  WindowControlsOverlayShape
>()("WindowControlsOverlay") {}

function readClasses(): readonly string[] {
  return windowControlsOverlayClasses(getWindowControlsOverlay(), window.innerWidth);
}

export const WindowControlsOverlayLive = Layer.effect(
  WindowControlsOverlay,
  Effect.gen(function* () {
    const classes = yield* SubscriptionRef.make(readClasses());
    const updates = yield* Queue.unbounded<readonly string[]>();

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(updates), (next) => SubscriptionRef.set(classes, next)),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const overlay = getWindowControlsOverlay();
        const update = () => {
          Queue.offerUnsafe(updates, readClasses());
        };
        overlay?.addEventListener("geometrychange", update);
        window.addEventListener("resize", update);
        return update;
      }),
      (update) =>
        Effect.sync(() => {
          const overlay = getWindowControlsOverlay();
          overlay?.removeEventListener("geometrychange", update);
          window.removeEventListener("resize", update);
        }),
    );

    return { changes: SubscriptionRef.changes(classes) };
  }),
);
