import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import type { Target } from "../src/runner.ts";
import { suite } from "../src/suite.ts";

const node = Node.layer({ features: ["cdp"] });

const PNG_SIGNATURE = "PNG";
/** Where a PNG says how many pixels wide and high it is. */
const PNG_WIDTH_AT = 16;
const PNG_HEIGHT_AT = 20;

const isPng = (picture: Uint8Array) =>
  new TextDecoder().decode(picture.subarray(1, 4)) === PNG_SIGNATURE;

const same = (one: Uint8Array, other: Uint8Array) =>
  one.length === other.length && one.every((byte, at) => byte === other[at]);

/** The number a PNG has at a place, which it writes highest byte first. */
const numberAt = (picture: Uint8Array, at: number) =>
  new DataView(picture.buffer, picture.byteOffset, picture.byteLength).getUint32(at);

interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

const hasViewport = (target: Target | undefined, viewport: Viewport) =>
  target !== undefined &&
  target.width === viewport.width &&
  target.height === viewport.height &&
  target.scale === viewport.scale;

suite(node)("the targets of a session on a node", (it) => {
  let session: string;
  let opened: Node.Opened;
  let firstTab: Target;
  let openedPicture: Uint8Array;

  const screenshot = (target: string) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      return yield* Node.bytes(executor, session, `/targets/${target}/screenshot.png`);
    });

  /** Asks for a viewport and waits until the opened target has `becomes`. */
  const resize = (asked: Viewport, becomes: Viewport = asked) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.session(session, "PUT", `/targets/${opened.id}/viewport`, asked);
      return yield* Node.targetsOnce(
        executor,
        session,
        `the target being ${becomes.width}x${becomes.height} at ${becomes.scale}`,
        (all) =>
          hasViewport(
            all.find((target) => target.id === opened.id),
            becomes,
          ),
      );
    });

  it.effect("a session's pages are its targets: the first tab and one opened since", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      session = (yield* executor.client.sessions.create()).id;
      opened = yield* Node.open(executor, session, Node.TRIAL_PAGE);

      const all = yield* Node.targets(executor, session);
      expect(all).toHaveLength(2);
      expect(all.at(-1)?.id).toBe(opened.id);
      firstTab = all[0]!;
    }),
  );

  it.effect("a new target is at the viewport size", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const all = yield* Node.targets(executor, session);
      expect(all.at(-1)).toMatchObject({ width: 1280, height: 720 });
    }),
  );

  it.effect("a target's screenshot is a PNG", () =>
    Effect.gen(function* () {
      openedPicture = yield* screenshot(opened.id);
      expect(isPng(openedPicture)).toBe(true);
    }),
  );

  it.effect("each target has a window of its own", () =>
    Effect.gen(function* () {
      const firstPicture = yield* screenshot(firstTab.id);
      expect(isPng(firstPicture)).toBe(true);
      expect(same(firstPicture, openedPicture)).toBe(false);
    }),
  );

  // A target has a viewport of its own: its page's size and how many pixels it draws to one.
  it.effect("a target takes a viewport and scale of its own", () =>
    Effect.gen(function* () {
      const all = yield* resize({ width: 800, height: 600, scale: 2 });
      expect(all.at(-1)).toMatchObject({ width: 800, height: 600, scale: 2 });
      expect(all[0]).toMatchObject({ width: 1280, height: 720, scale: 1 });
    }),
  );

  it.effect("its page has the size and the pixel ratio", () =>
    Effect.gen(function* () {
      const seen = yield* opened.page.evaluate(
        "[innerWidth, innerHeight, devicePixelRatio].join()",
      );
      expect(seen).toBe("800,600,2");
    }),
  );

  it.effect("its picture has the pixels", () =>
    Effect.gen(function* () {
      const picture = yield* screenshot(opened.id);
      expect(numberAt(picture, PNG_WIDTH_AT)).toBe(1600);
      expect(numberAt(picture, PNG_HEIGHT_AT)).toBe(1200);
    }),
  );

  it.effect("a viewport is bounded to what can be drawn", () =>
    Effect.gen(function* () {
      const all = yield* resize(
        { width: 9000, height: 100, scale: 9 },
        { width: 4096, height: 100, scale: 1 },
      );
      expect(all.at(-1)).toMatchObject({ width: 4096, height: 100, scale: 1 });
    }),
  );

  it.effect("and goes back to what it was", () =>
    Effect.gen(function* () {
      const all = yield* resize({ width: 1280, height: 720, scale: 1 });
      expect(all.at(-1)).toMatchObject({ width: 1280, height: 720, scale: 1 });
    }),
  );

  it.effect("a page that a page opens is a target", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* opened.page.evaluate("window.open('about:blank') && 1");

      const all = yield* Node.targetsOnce(
        executor,
        session,
        "the popup being a target",
        (all) => all.length === 3,
      );
      const popups = all.filter((target) => ![firstTab.id, opened.id].includes(target.id));
      expect(popups).toHaveLength(1);
    }),
  );

  it.effect("a closed page is no target", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const before = yield* Node.targets(executor, session);
      const popup = before.find((target) => ![firstTab.id, opened.id].includes(target.id));
      yield* opened.cdp.call("Target.closeTarget", { targetId: popup?.id });

      const all = yield* Node.targetsOnce(
        executor,
        session,
        "the popup being no target",
        (all) => all.length === 2,
      );
      expect(all.map((target) => target.id)).toEqual([firstTab.id, opened.id]);
    }),
  );
});
