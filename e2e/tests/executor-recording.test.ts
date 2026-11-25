import * as UrlPath from "@aperture-browser/shared/url-path";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Executor } from "../src/executor.ts";
import * as Files from "../src/files.ts";
import { read } from "../src/http.ts";
import * as Mcp from "../src/mcp.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { type Page, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens, until } from "../src/wait.ts";

const node = Layer.mergeAll(
  Node.layer({ features: ["cdp", "mcp", "recordings"] }),
  ViewerLive.layer,
);

/** What the journal of a recording says automation did, one entry to a line. */
const JournalEntry = Schema.Struct({
  kind: Schema.String,
  at_ms: Schema.Number,
  end_ms: Schema.Number,
  text: Schema.optional(Schema.String),
  follow: Schema.optional(Schema.String),
  ended: Schema.optional(Schema.String),
  rect: Schema.optional(Schema.Struct({ x: Schema.Number })),
  button: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
});
type JournalEntry = typeof JournalEntry.Type;

/** An edit as the `recording` tool tells it; it has no file until it is made. */
const Edit = Schema.Struct({
  state: Schema.String,
  file: Schema.NullishOr(Schema.String),
  timeline: Schema.NullishOr(Schema.String),
});
type Edit = typeof Edit.Type;

/** A recording as the `recording` tool tells it while it goes on. */
const Started = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    journal: Schema.String,
    edit: Schema.NullishOr(Edit),
  }),
);
type Started = typeof Started.Type;

/** A recording as the `recording` tool tells it once it stopped. */
const Recording = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    state: Schema.String,
    duration_ms: Schema.Number,
    bytes: Schema.Number,
    file: Schema.String,
    journal: Schema.String,
    edit: Schema.NullishOr(Edit),
  }),
);
type Recording = typeof Recording.Type;

/** How an edit's time maps to the raw recording's. */
const Timeline = Schema.Struct({
  duration_ms: Schema.Number,
  edited_duration_ms: Schema.Number,
  map: Schema.Array(Schema.Unknown),
  events: Schema.Array(Schema.Struct({ at_ms: Schema.Number, edited_at_ms: Schema.Number })),
});

const MATROSKA_SIGNATURE = "1a45dfa3";
const TYPED = "typed by the agent, letter by letter";
/** Where the trial page's button is, and so where a click on it goes. */
const BUTTON = { left: 100, x: 250, y: 350 };

suite(node)("recordings of a session of a node, made by automation", (it) => {
  let session: string;
  let opened: Node.Opened;
  let watcher: Page;
  let agent: Mcp.Mcp;
  let started: Started;
  let stopped: Recording;
  let journal: readonly JournalEntry[];
  let edit: Edit;

  const title = () => opened.page.evaluate("document.title");

  const recording = (args: object) => agent.call("recording", args);

  /** How many times the wheel turned so far, by the journal as it is written. */
  const wheelsSoFar = Effect.gen(function* () {
    const executor = yield* Executor;
    const written = yield* Files.journal(
      `${executor.data}/sessions/${session}/files/${started.journal}`,
      JournalEntry,
    );
    return written.filter((entry) => entry.kind === "wheel").length;
  });

  /** Waits until the edit of a recording is made, or failed, and gives it. */
  const edited = (id: string) =>
    until(
      "the edit being made",
      recording({ action: "status", id }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Started)),
        Effect.map(({ edit: made }) => {
          return made !== undefined && made !== null && made.state !== "editing" && made;
        }),
      ),
      "1 minute",
    );

  const timelineOf = (made: Edit) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const answer = yield* executor.session(
        session,
        "GET",
        UrlPath.make`/files/${UrlPath.segments(made.timeline ?? "")}`,
      );
      return yield* read(answer, Timeline);
    });

  // Recording: the target's own stream into a file, with the pointer in the picture.
  it.effect("the viewer's cursor is hidden while the pointer is recorded", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const viewer = yield* Viewer;
      session = (yield* executor.client.sessions.create()).id;
      opened = yield* Node.open(executor, session, Node.TRIAL_PAGE);
      watcher = yield* Node.watch(viewer, executor, session);
      yield* happens(snapshot(watcher, `s.selected === ${opened.tab}`));
      agent = yield* Mcp.connect(
        UrlPath.make`${UrlPath.raw(executor.url)}/sessions/${session}`,
        executor.token,
      );

      started = yield* recording({ action: "start", tab: opened.id }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Started)),
      );

      const hidden = yield* happens(snapshot(watcher, "s.cursor === 'none'"), "5 seconds");
      expect(hidden).toBe(true);
    }),
  );

  // Scrolling and filling a field show as they would by hand.
  it.effect("a field is filled as if typed while recorded", () =>
    Effect.gen(function* () {
      // What the journal and the edit are checked for below: the pointer travelling, a
      // caption, a focus on the button over a click and until it is reset, an attention.
      for (const [x, y] of [
        [200, 200],
        [600, 300],
        [BUTTON.x, BUTTON.y],
      ]) {
        yield* agent.call("hover", { tab: opened.id, x, y });
        yield* Effect.sleep("250 millis");
      }
      yield* recording({ action: "caption", text: "clicking the button", duration_ms: 2500 });
      yield* recording({ action: "focus", selector: "button", zoom: 2 });
      yield* Effect.sleep("700 millis");
      yield* agent.call("click", { tab: opened.id, selector: "button" });
      yield* Effect.sleep("700 millis");
      yield* recording({ action: "reset_focus" });
      yield* recording({ action: "attention", selector: "#i", duration_ms: 600 });

      const [took] = yield* Effect.timed(
        agent.call("fill", { tab: opened.id, selector: "#i", value: TYPED }),
      );

      expect(Duration.toMillis(took)).toBeGreaterThan(900);
      expect(yield* title()).toBe(`typed:${TYPED}`);
    }),
  );

  it.effect("a scroll to an edge travels there while recorded", () =>
    Effect.gen(function* () {
      yield* agent.call("scroll", { tab: opened.id, deltaY: 900 });
      yield* agent.call("scroll", { tab: opened.id, deltaY: -900 });

      const before = yield* wheelsSoFar;
      const atBottom = yield* agent.call("scroll", { tab: opened.id, to: "bottom" });
      yield* agent.call("scroll", { tab: opened.id, to: "top" });
      const after = yield* wheelsSoFar;

      expect(atBottom).toMatch(/"atBottom": true/u);
      expect(after - before).toBeGreaterThan(20);
    }),
  );

  // Every step of a travel waits for the tab on its own; they went once it was free in the
  // order they woke in, with the press amid them.
  it.effect("a click that waits for a tab someone holds travels there, then presses", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const path = `${executor.data}/sessions/${session}/files/${started.journal}`;
      const from = { x: 900, y: 600 };
      yield* agent.call("hover", { tab: opened.id, ...from });
      const before = (yield* Files.journal(path, JournalEntry)).length;
      // A person's input comes before the automation's, which waits until they are done.
      yield* Node.clickInPicture(watcher, "video", from);
      const holds = yield* happens(
        snapshot(
          watcher,
          `s.presence.held.some((h) => h.tab === ${opened.tab} && h.holder === s.presence.you)`,
        ),
      );
      expect(holds).toBe(true);
      const [took] = yield* Effect.timed(
        agent.call("click", { tab: opened.id, x: BUTTON.x, y: BUTTON.y }),
      );

      const pointer = (yield* Files.journal(path, JournalEntry))
        .slice(before)
        .filter((entry) => entry.kind === "move" || entry.kind === "press");
      const away = (entry: JournalEntry) =>
        Math.hypot((entry.x ?? 0) - BUTTON.x, (entry.y ?? 0) - BUTTON.y);
      const pressed = pointer.findIndex((entry) => entry.kind === "press");
      const travel = pointer.slice(0, pressed);
      const back = travel.filter(
        (entry, index) => index > 0 && away(entry) > away(travel[index - 1]!) + 20,
      );

      expect(Duration.toMillis(took)).toBeGreaterThan(2000);
      expect(travel.length).toBeGreaterThan(5);
      expect(Math.hypot(travel[0]!.x! - from.x, travel[0]!.y! - from.y)).toBeLessThan(100);
      expect(back).toEqual([]);
      expect(pointer.slice(pressed + 1)).toEqual([]);
    }),
  );

  it.effect("a recording finishes with a length", () =>
    Effect.gen(function* () {
      // Nothing happens for a while, which the edit cuts.
      yield* Effect.sleep("2500 millis");
      stopped = yield* recording({
        action: "stop",
        id: started.id,
        idle: "cut",
        ripple: true,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Recording)));

      expect(stopped.state).toBe("finished");
      expect(stopped.duration_ms).toBeGreaterThan(5000);
      expect(stopped.bytes).toBeGreaterThan(1000);
    }),
  );

  it.effect("stop returns while the edit is made", () =>
    Effect.sync(() => {
      expect(stopped.edit?.state).toBe("editing");
    }),
  );

  it.effect("the recording is served as a Matroska file", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const file = yield* Node.bytes(
        executor,
        session,
        UrlPath.make`/files/${UrlPath.segments(stopped.file)}`,
      );
      expect(file).toHaveLength(stopped.bytes);
      expect(Hex.encode(file.subarray(0, 4))).toBe(MATROSKA_SIGNATURE);
    }),
  );

  it.effect("the journal has what the automation did", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const served = yield* Node.bytes(
        executor,
        session,
        UrlPath.make`/files/${UrlPath.segments(stopped.journal)}`,
      );
      journal = yield* Files.entries(new TextDecoder().decode(served), JournalEntry);

      const kinds = new Set(journal.map((entry) => entry.kind));
      expect(Array.from(kinds)).toEqual(
        expect.arrayContaining(["move", "press", "call", "caption", "focus", "attention"]),
      );
      expect(journal.find((entry) => entry.kind === "caption")?.text).toBe("clicking the button");
    }),
  );

  it.effect("the focus is on the button, until it was reset", () =>
    Effect.sync(() => {
      const focus = journal.find((entry) => entry.kind === "focus")!;
      expect(focus.follow).toBe("element");
      expect(focus.ended).toBe("reset");
      expect(Math.abs(focus.rect!.x - BUTTON.left)).toBeLessThan(2);
      expect(focus.end_ms - focus.at_ms).toBeGreaterThan(1000);
    }),
  );

  it.effect("the edit finishes", () =>
    Effect.gen(function* () {
      edit = yield* edited(started.id);
      expect(edit.state).toBe("finished");
    }),
  );

  it.effect("the edited video is an MP4", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const file = yield* Node.bytes(
        executor,
        session,
        UrlPath.make`/files/${UrlPath.segments(edit.file ?? "")}`,
      );
      expect(new TextDecoder().decode(file.subarray(4, 8))).toBe("ftyp");
      expect(file.length).toBeGreaterThan(1000);
    }),
  );

  it.effect("the edit cut the idle stretch", () =>
    Effect.gen(function* () {
      const timeline = yield* timelineOf(edit);
      expect(timeline.edited_duration_ms).toBeLessThan(timeline.duration_ms - 1000);
      expect(timeline.map.length).toBeGreaterThanOrEqual(1);
      expect(timeline.events.filter((event) => event.edited_at_ms > event.at_ms)).toEqual([]);
    }),
  );

  it.effect("journal times are in the video's time", () =>
    Effect.sync(() => {
      const outside = journal.filter(
        (entry) =>
          entry.at_ms < 0 || entry.at_ms > entry.end_ms || entry.end_ms > stopped.duration_ms + 100,
      );
      expect(outside).toEqual([]);
      expect(journal.some((entry) => entry.at_ms > 500)).toBe(true);
    }),
  );

  it.effect("the wheel turns in many small steps while recorded", () =>
    Effect.sync(() => {
      expect(journal.filter((entry) => entry.kind === "wheel").length).toBeGreaterThan(20);
    }),
  );

  it.effect("the pointer travels to where it acts while recorded", () =>
    Effect.sync(() => {
      expect(journal.filter((entry) => entry.kind === "move").length).toBeGreaterThan(30);
    }),
  );

  it.effect("the journal's press is where the click went", () =>
    Effect.sync(() => {
      const onButton = journal.filter(
        (entry) =>
          entry.kind === "press" &&
          entry.button === "left" &&
          Math.abs((entry.x ?? 0) - BUTTON.x) < 150 &&
          Math.abs((entry.y ?? 0) - BUTTON.y) < 50,
      );
      expect(onButton.length).toBeGreaterThan(0);
    }),
  );

  // A caret blinks in the field all the while. With every change of a pixel counting, only
  // its steady beat tells it from something happening.
  it.effect("a blinking caret does not keep a page from being idle", () =>
    Effect.gen(function* () {
      yield* agent.call("click", { tab: opened.id, selector: "#i" });
      const blinking = yield* recording({ action: "start", tab: opened.id }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Started)),
      );
      yield* agent.call("hover", { tab: opened.id, x: 700, y: 200 });
      // Long enough that what is cut of it is told from how long the hover took.
      yield* Effect.sleep("7 seconds");
      yield* recording({ action: "stop", id: blinking.id, idle: "cut", motion_threshold: 0 });

      const timeline = yield* timelineOf(yield* edited(blinking.id));
      expect(timeline.edited_duration_ms).toBeLessThan(timeline.duration_ms - 1500);
    }),
  );

  it.effect("the pace the automation sets is told to whoever watches", () =>
    Effect.gen(function* () {
      expect(yield* snapshot(watcher, "s.pace")).toBe("fast");
      expect(yield* agent.call("pace", { pace: "slow" })).toMatch(/"pace": "slow"/u);
      expect(yield* happens(snapshot(watcher, "s.pace === 'slow'"), "5 seconds")).toBe(true);
    }),
  );

  it.effect("the viewer's cursor is back once nothing is recorded", () =>
    Effect.gen(function* () {
      expect(yield* snapshot(watcher, "s.cursor")).not.toBe("none");
    }),
  );

  it.effect("the viewer still plays after the recordings", () =>
    Effect.gen(function* () {
      expect(yield* snapshot(watcher, "s.picture.rtc")).toBe("connected");
      expect(yield* watcher.evaluate("window.peers.at(-1)?.connectionState")).toBe("connected");
    }),
  );
});
