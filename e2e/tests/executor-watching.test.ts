import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { type Page, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import { comes } from "../src/workbench.ts";

// The viewer is a person's browser: one outside any session, with a network of its own.
const node = Layer.mergeAll(Node.layer({ features: ["cdp"] }), ViewerLive.layer);

/** Where the trial page's button and field are, in the page. */
const BUTTON = { x: 250, y: 350 };
const FIELD = { x: 300, y: 470 };

/** How long a picture gets to come, and input to arrive. */
const SHOWN_WITHIN_MS = 15_000;
const ARRIVES_WITHIN_MS = 5000;

/** Whether the canvas of a workbench has a pixel that is not black. */
const CANVAS_IS_LIT = `(() => {
  const canvas = document.querySelector("[data-aperture-surface=canvas]");
  if (!canvas || canvas.width === 0 || canvas.height === 0) {
    return false;
  }
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  return pixels.some((value, index) => index % 4 !== 3 && value > 0);
})()`;

suite(node)("watching a session of a node", (it) => {
  let session: string;
  let opened: Node.Opened;
  let watcher: Page;

  const title = () => opened.page.evaluate("document.title");
  const titleBecomes = (wanted: string) =>
    happens(
      opened.page.evaluate(`document.title === ${JSON.stringify(wanted)}`),
      ARRIVES_WITHIN_MS,
    );

  it.effect("a viewer plays the session's newest target over WebRTC", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const viewer = yield* Viewer;
      session = (yield* executor.client.sessions.create()).id;
      opened = yield* Node.open(executor, session, Node.TRIAL_PAGE);

      watcher = yield* Node.watch(viewer, executor, session);
      yield* happens(
        Node.pictureSize(watcher, "video").pipe(Effect.map((size) => size === "1280x720")),
        SHOWN_WITHIN_MS,
      );

      expect(yield* Node.pictureSize(watcher, "video")).toBe("1280x720");
      expect(yield* snapshot(watcher, "s.picture.way")).toBe("video");
      expect(yield* snapshot(watcher, "s.selected")).toBe(opened.tab);
    }),
  );

  it.effect("the watched page fills the viewport", () =>
    Effect.gen(function* () {
      expect(yield* opened.page.evaluate("innerWidth + 'x' + innerHeight")).toBe("1280x720");
    }),
  );

  // Input goes the whole way: a click and keys in the viewer reach the session's page.
  it.effect("a click in the viewer reaches the session's page", () =>
    Effect.gen(function* () {
      yield* Node.clickInPicture(watcher, "video", BUTTON);
      yield* titleBecomes("clicked");
      expect(yield* title()).toBe("clicked");
    }),
  );

  it.effect("keys in the viewer reach the session's page", () =>
    Effect.gen(function* () {
      yield* Node.clickInPicture(watcher, "video", FIELD);
      // The keys go to what the click gave the keyboard, once it has it.
      yield* happens(opened.page.evaluate("document.activeElement?.id === 'i'"), ARRIVES_WITHIN_MS);
      yield* watcher.type("hi");
      yield* titleBecomes("typed:hi");
      expect(yield* title()).toBe("typed:hi");
    }),
  );

  // Clients with no WebRTC: the same video as frames on the session socket, or tiles.
  for (const way of ["frames", "tiles"] as const) {
    let other: Page;

    it.effect(`a viewer without WebRTC gets the target's picture as ${way}`, () =>
      Effect.gen(function* () {
        const executor = yield* Executor;
        const viewer = yield* Viewer;
        other = yield* Node.watch(viewer, executor, session, { pixels: way });
        const lit = yield* happens(other.evaluate(CANVAS_IS_LIT), SHOWN_WITHIN_MS);

        expect(lit).toBe(true);
        expect(yield* snapshot(other, "s.picture.way")).toBe(way);
        expect(yield* Node.pictureSize(other, "canvas")).toBe("1280x720");
        expect(yield* other.evaluate("window.peers.length")).toBe(0);
        expect(yield* snapshot(other, "s.selected")).toBe(opened.tab);
      }),
    );

    it.effect(`a click in the ${way} viewer reaches the session's page`, () =>
      Effect.gen(function* () {
        yield* opened.page.evaluate("document.title = 'waiting'");
        // Whoever gave the tab input last holds it, and an equal would have to ask for it.
        yield* watcher.evaluate("apertureSession.lease('release')");
        // Let go on another socket than the click comes on: the click is the one viewer's
        // once the other's letting go is known where it is made.
        expect(yield* comes(other, "s.presence.held.length === 0")).toBe(true);
        yield* Node.clickInPicture(other, "canvas", BUTTON);
        yield* titleBecomes("clicked");
        expect(yield* title()).toBe("clicked");
        yield* other.close;
      }),
    );
  }

  it.effect("the viewer's page threw nothing", () =>
    Effect.sync(() => {
      expect(watcher.errors()).toEqual([]);
    }),
  );
});
