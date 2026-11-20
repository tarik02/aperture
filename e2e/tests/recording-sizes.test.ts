import { readFileSync } from "node:fs";
import { type Address, SessionHttp } from "@aperture-browser/session-client/effect";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { colourAt, frameSizes } from "../src/video.ts";
import { until } from "../src/wait.ts";

const session = Runner.layer({ features: ["cdp", "recordings"] });

/** A small square of another colour on the first tab's page, for a zoom to find. */
const MARK = { x: 300, y: 200, width: 40, height: 40 };

/** A page that is one colour all over, but for the mark where it has one. */
const coloured = (colour: string, mark = "") =>
  `data:text/html,<title>${colour}</title><body style="margin:0;background:${colour}">${mark}`;

const mark = `<div style="position:fixed;left:${MARK.x}px;top:${MARK.y}px;width:${MARK.width}px;height:${MARK.height}px;background:lime"></div>`;

/** What the timeline says of a stretch in which the raw picture has one size. */
interface Segment {
  readonly raw_start_ms: number;
  readonly width: number;
  readonly height: number;
  /** Where its picture is in the edit's frame. */
  readonly x: number;
  readonly y: number;
}

interface TimelineEvent {
  readonly kind: string;
  readonly edited_at_ms: number;
  readonly edited_end_ms: number;
}

interface Timeline {
  readonly width: number;
  readonly height: number;
  readonly edited_duration_ms: number;
  readonly segments: readonly Segment[];
  readonly events: readonly TimelineEvent[];
}

suite(session)("a recording whose picture changes size", (it) => {
  let address: Address;
  let first: Runner.Target;
  let second: Runner.Target;
  let recording: SessionHttp.Recording;
  let stopped: SessionHttp.Recording;
  let edited: string;
  let timeline: Timeline;

  /** Gives a tab a size and waits until the tab has it. */
  const resize = (target: Runner.Target, width: number, height: number) =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      yield* SessionHttp.setViewport(address, target.tab, { width, height });
      yield* until(
        `tab ${target.tab} being ${width}x${height}`,
        runner.targets.pipe(
          Effect.map((all) =>
            all.some(
              (other) => other.id === target.id && other.width === width && other.height === height,
            ),
          ),
        ),
      );
    });

  /** The colour the edited video shows at a time of the raw one: nothing is cut from it. */
  const shows = (rawMs: number, x: number, y: number) => colourAt(edited, rawMs / 1000, { x, y });

  it.effect("two tabs have sizes of their own", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      address = { url: runner.url, token: runner.token };
      first = (yield* runner.targets)[0]!;
      const cdp = yield* runner.cdp;
      const page = yield* cdp.attach(first.id);
      yield* page.call("Page.navigate", { url: coloured("red", mark) });
      yield* cdp.call("Target.createTarget", { url: coloured("blue") });
      second = yield* until(
        "the second tab",
        runner.targets.pipe(Effect.map((all) => all.find((target) => target.id !== first.id))),
      );
      yield* resize(first, 1000, 700);
      yield* resize(second, 640, 900);
      // The recording is to begin with a picture of the size the tab now has.
      yield* Effect.sleep(1000);
    }),
  );

  it.effect("a recording goes on as its tab changes size", () =>
    Effect.gen(function* () {
      recording = yield* SessionHttp.startRecording(address, { tab: first.tab });
      // Every size's part of the video needs some length to be looked into.
      yield* Effect.sleep(2000);
      yield* resize(first, 800, 600);
      yield* Effect.sleep(1500);
      const still = yield* SessionHttp.getRecording(address, recording.id);
      expect(still.state).toBe("recording");
    }),
  );

  it.effect("a zoom is asked for while the picture is smaller than the edit's frame", () =>
    Effect.gen(function* () {
      yield* SessionHttp.annotateRecording(address, {
        kind: "focus",
        zoom: 4,
        rect: MARK,
        duration_ms: 1500,
      });
      // The picture is to be seen zoomed out again before it changes.
      yield* Effect.sleep(700);
    }),
  );

  it.effect("it goes on with a tab of another size, which keeps its size", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const moved = yield* SessionHttp.retargetRecording(address, recording.id, second.tab);
      expect(moved.tab).toBe(second.tab);
      const kept = (yield* runner.targets).find((target) => target.id === second.id);
      expect(kept).toMatchObject({ width: 640, height: 900 });
      // The second tab's part of the video needs some length too.
      yield* Effect.sleep(2000);
    }),
  );

  it.effect("it stops", () =>
    Effect.gen(function* () {
      stopped = yield* SessionHttp.stopRecording(address, recording.id);
      expect(stopped.failure).toBeNull();
      expect(stopped.state).toBe("finished");
    }),
  );

  it.effect("the raw video has every size the picture had", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const sizes = yield* frameSizes(`${runner.files}/${stopped.file}`);
      expect(sizes).toEqual(["1000x700", "800x600", "640x900"]);
    }),
  );

  it.effect("the edited video has the one size all of them fit in", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const edit = yield* until(
        "the edit being made",
        SessionHttp.getRecording(address, recording.id).pipe(
          Effect.map(({ edit }) => (edit === null || edit.state === "editing" ? undefined : edit)),
        ),
        60_000,
      );
      expect(edit).toMatchObject({ state: "finished", failure: null });
      edited = `${runner.files}/${edit.file}`;
      timeline = JSON.parse(readFileSync(`${runner.files}/${edit.timeline}`, "utf8")) as Timeline;
      expect(yield* frameSizes(edited)).toEqual(["1000x900"]);
    }),
  );

  it.effect("the timeline tells where each size's picture is in the frame", () =>
    Effect.sync(() => {
      expect(timeline).toMatchObject({ width: 1000, height: 900 });
      expect(timeline.segments).toMatchObject([
        { raw_start_ms: 0, width: 1000, height: 700, x: 0, y: 100 },
        { width: 800, height: 600, x: 100, y: 150 },
        { width: 640, height: 900, x: 180, y: 0 },
      ]);
    }),
  );

  it.effect("the edited video lasts as long as the raw one", () =>
    Effect.sync(() => {
      const apart = Math.abs(timeline.edited_duration_ms - stopped.duration_ms!);
      expect(apart).toBeLessThan(50);
    }),
  );

  it.effect("the first picture is in the middle of the frame", () =>
    Effect.gen(function* () {
      const at = timeline.segments[0]!.raw_start_ms + 1000;
      expect(yield* shows(at, 500, 450)).toBe("red");
      expect(yield* shows(at, 20, 120)).toBe("red");
      expect(yield* shows(at, 500, 50)).toBe("black");
    }),
  );

  it.effect("the smaller one is in the middle too", () =>
    Effect.gen(function* () {
      const at = timeline.segments[1]!.raw_start_ms + 700;
      expect(yield* shows(at, 500, 450)).toBe("red");
      expect(yield* shows(at, 20, 450)).toBe("black");
      expect(yield* shows(at, 500, 120)).toBe("black");
    }),
  );

  it.effect("and so is the other tab's", () =>
    Effect.gen(function* () {
      const at = stopped.duration_ms! - 700;
      expect(yield* shows(at, 500, 50)).toBe("blue");
      expect(yield* shows(at, 100, 450)).toBe("black");
    }),
  );

  it.effect("a zoom on the smaller picture lands on what it was asked to show", () =>
    Effect.gen(function* () {
      const focus = timeline.events.find((event) => event.kind === "focus");
      expect(focus).toBeDefined();
      // The mark is told where it is in its own picture, which begins 100,150 into the
      // frame. Zoomed on it, the mark is the middle of the frame; zoomed on the same
      // place of the frame, the middle is the page around it.
      const zoomed = (focus!.edited_at_ms + focus!.edited_end_ms) / 2;
      expect(yield* shows(zoomed, 500, 450)).toBe("green");
      expect(yield* shows(zoomed, 500 - 3 * MARK.width, 450)).toBe("red");
    }),
  );
});
