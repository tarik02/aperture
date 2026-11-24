import * as UrlPath from "@aperture-browser/shared/url-path";
import { type Address, SessionHttp } from "@aperture-browser/session-client/effect";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Executor } from "../src/executor.ts";
import * as Files from "../src/files.ts";
import * as Mcp from "../src/mcp.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { frameCount } from "../src/video.ts";
import { until } from "../src/wait.ts";

const node = Node.layer({ features: ["cdp", "mcp", "recordings"] });

const JournalEntry = Schema.Struct({ kind: Schema.String });

const Timeline = Schema.Struct({
  duration_ms: Schema.Number,
  edited_duration_ms: Schema.Number,
});
type Timeline = typeof Timeline.Type;

/** A recording as the `recording` tool tells it. */
const Told = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    state: Schema.String,
    edit: Schema.NullishOr(Schema.Struct({ state: Schema.String })),
  }),
);

/** How an edit is made when nothing is said of it. */
const DEFAULTS = {
  capture: "continuous",
  idle: null,
  ripple: false,
  burst: { lead_ms: 500, tail_ms: 800, settle_ms: 400, max_tail_ms: 3000 },
  motion_threshold: 0.0002,
  fps: 60,
};

suite(node)("a recording's edit, said as it stops and made again after", (it) => {
  let session: string;
  let address: Address;
  let files: string;
  let opened: Node.Opened;
  let agent: Mcp.Mcp;
  /** Two recordings of one tab that run at once: stopped whole, and stopped as bursts. */
  let whole: SessionHttp.Recording;
  let bursts: SessionHttp.Recording;
  let wholeEdit: SessionHttp.RecordingEdit;
  let wholeFrames: number;

  /** How many times the pointer came to rest so far, by a journal as it is written. */
  const movesSoFar = (recording: SessionHttp.Recording) =>
    Files.journal(`${files}/${recording.journal}`, JournalEntry).pipe(
      Effect.map((journal) => journal.filter((entry) => entry.kind === "move").length),
    );

  /** Waits until the edit of a recording is made, or failed, and gives it. */
  const edited = (id: string) =>
    until(
      "the edit being made",
      SessionHttp.getRecording(address, id).pipe(
        Effect.map(({ edit }) => (edit === null || edit.state === "editing" ? undefined : edit)),
      ),
      "1 minute",
    );

  const timelineOf = (edit: SessionHttp.RecordingEdit) =>
    Files.json(`${files}/${edit.timeline}`, Timeline);

  /** Asks for an edit as a caller that takes the answer as it is. */
  const askEdit = (id: string, options: object) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      return yield* executor.session(
        session,
        "POST",
        UrlPath.make`/recordings/${id}/edit`,
        options,
      );
    });

  it.effect("the session's pace is fast until it is set, by its tool or over HTTP", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      session = (yield* executor.client.sessions.create()).id;
      address = {
        url: UrlPath.make`${UrlPath.raw(executor.url)}/sessions/${session}`,
        token: executor.token,
      };
      files = `${executor.data}/sessions/${session}/files`;
      opened = yield* Node.open(executor, session, Node.TRIAL_PAGE);
      agent = yield* Mcp.connect(address.url, executor.token);

      expect(yield* SessionHttp.getPace(address)).toBe("fast");
      expect(yield* agent.call("pace")).toMatch(/"pace": "fast"/u);
      expect(yield* SessionHttp.setPace(address, "slow")).toBe("slow");
      expect(yield* agent.call("pace")).toMatch(/"pace": "slow"/u);
      expect(yield* agent.call("pace", { pace: "instant" })).toMatch(/"pace": "instant"/u);
      expect(yield* SessionHttp.getPace(address)).toBe("instant");

      const unknown = yield* executor.session(session, "PUT", "/pace", { pace: "hurried" });
      expect(unknown.status).toBeGreaterThanOrEqual(400);
      expect(yield* SessionHttp.getPace(address)).toBe("instant");
    }),
  );

  it.effect("two recordings that run at once go by the one pace", () =>
    Effect.gen(function* () {
      whole = yield* SessionHttp.startRecording(address, { tab: opened.tab });
      bursts = yield* SessionHttp.startRecording(address, { tab: opened.tab });
      expect(whole.state).toBe("recording");
      expect(whole.edit).toBeNull();
      // Either has some length before anything is done.
      yield* Effect.sleep("1 second");

      // At once: the pointer is where it acts, and came there by no way.
      yield* agent.call("hover", { tab: opened.id, x: 700, y: 500 });
      const jumped = yield* movesSoFar(whole);
      expect(jumped).toBeLessThanOrEqual(2);
      expect(yield* movesSoFar(bursts)).toBe(jumped);

      yield* agent.call("pace", { pace: "fast" });
      yield* agent.call("hover", { tab: opened.id, x: 150, y: 120 });
      const travelled = yield* movesSoFar(whole);
      expect(travelled - jumped).toBeGreaterThan(10);
      expect(yield* movesSoFar(bursts)).toBe(travelled);
    }),
  );

  it.effect("a recording that runs has no edit to make again", () =>
    Effect.gen(function* () {
      const early = yield* askEdit(whole.id, { capture: "bursts" });
      expect(early.status).toBe(409);
    }),
  );

  it.effect("each is stopped with options of its own", () =>
    Effect.gen(function* () {
      // Nothing is done for a while, which only an edit of what automation did leaves out.
      yield* Effect.sleep("2500 millis");
      const told = yield* agent
        .call("recording", {
          action: "stop",
          id: bursts.id,
          capture: "bursts",
          burst: { tail_ms: 200, settle_ms: 100, max_tail_ms: 400 },
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Told)));
      expect(told).toMatchObject({ state: "finished", edit: { state: "editing" } });
      whole = yield* SessionHttp.stopRecording(address, whole.id);
      expect(whole.state).toBe("finished");
      expect(whole.edit?.state).toBe("editing");
    }),
  );

  it.effect("stopped with no options, a recording's edit is all of it at 60 frames", () =>
    Effect.gen(function* () {
      wholeEdit = yield* edited(whole.id);
      expect(wholeEdit).toMatchObject({ state: "finished", failure: null, options: DEFAULTS });
      const timeline = yield* timelineOf(wholeEdit);
      expect(timeline.edited_duration_ms).toBe(timeline.duration_ms);

      wholeFrames = yield* frameCount(`${files}/${wholeEdit.file}`);
      const seconds = timeline.duration_ms / 1000;
      expect(wholeFrames).toBeGreaterThan(seconds * 60 * 0.9);
      expect(wholeFrames).toBeLessThan(seconds * 60 * 1.1);
    }),
  );

  it.effect("stopped as bursts, the other's edit keeps what automation did alone", () =>
    Effect.gen(function* () {
      const edit = yield* edited(bursts.id);
      expect(edit).toMatchObject({
        state: "finished",
        options: {
          ...DEFAULTS,
          capture: "bursts",
          burst: { lead_ms: 500, tail_ms: 200, settle_ms: 100, max_tail_ms: 400 },
        },
      });
      const timeline = yield* timelineOf(edit);
      expect(timeline.edited_duration_ms).toBeLessThan(timeline.duration_ms - 1500);
    }),
  );

  it.effect("edited again at 30 frames, the same raw video gives half the frames", () =>
    Effect.gen(function* () {
      const asked = yield* agent
        .call("recording", { action: "edit", id: whole.id, fps: 30 })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Told)));
      expect(asked.edit?.state).toBe("editing");

      const edit = yield* edited(whole.id);
      expect(edit).toMatchObject({ state: "finished", options: { ...DEFAULTS, fps: 30 } });
      // It took the place of the edit before.
      expect(edit.file).toBe(wholeEdit.file);
      expect(edit.made_at_ms).toBeGreaterThan(wholeEdit.made_at_ms ?? 0);
      const frames = yield* frameCount(`${files}/${edit.file}`);
      expect(wholeFrames / frames).toBeGreaterThan(1.8);
      expect(wholeFrames / frames).toBeLessThan(2.2);
    }),
  );

  it.effect("an edit is not made of a recording while another is", () =>
    Effect.gen(function* () {
      const first = yield* askEdit(whole.id, { idle: "cut" });
      expect(first.status).toBe(200);
      const second = yield* askEdit(whole.id, { idle: "speed" });
      expect(second.status).toBe(409);

      const edit = yield* edited(whole.id);
      expect(edit).toMatchObject({ state: "finished", options: { ...DEFAULTS, idle: "cut" } });
      const timeline = yield* timelineOf(edit);
      expect(timeline.edited_duration_ms).toBeLessThan(timeline.duration_ms - 1000);
    }),
  );

  it.effect("options that are none are refused, and the edit there is stays", () =>
    Effect.gen(function* () {
      for (const options of [{ fps: 0 }, { fps: 61 }, { capture: "bursts", idle: "cut" }]) {
        expect((yield* askEdit(whole.id, options)).status).toBe(400);
      }
      const told = yield* SessionHttp.getRecording(address, whole.id);
      expect(told.edit).toMatchObject({ state: "finished", options: { idle: "cut" } });
    }),
  );

  it.effect("a recording is edited again once the session was suspended and resumed", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.suspend(session);
      yield* executor.client.sessions.resume(session);

      // The pace is the session's, and stays with it.
      const pace = yield* until("the session's pace", SessionHttp.getPace(address));
      expect(pace).toBe("fast");

      const before = yield* SessionHttp.getRecording(address, whole.id);
      expect(before.edit).toMatchObject({ state: "finished", options: { idle: "cut" } });
      yield* SessionHttp.editRecording(address, whole.id, { capture: "bursts", ripple: true });
      const edit = yield* edited(whole.id);
      expect(edit).toMatchObject({
        state: "finished",
        failure: null,
        options: { ...DEFAULTS, capture: "bursts", ripple: true },
      });
      const timeline = yield* timelineOf(edit);
      expect(timeline.edited_duration_ms).toBeLessThan(timeline.duration_ms - 1500);
    }),
  );

  it.effect("a recording without its raw video is not edited again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${files}/${whole.file}`);

      const refused = yield* askEdit(whole.id, { fps: 30 });
      expect(refused.status).toBe(409);
      expect(String(refused.body)).toMatch(/raw video is gone/u);
      // The edit that was made of it is what there is.
      const told = yield* SessionHttp.getRecording(address, whole.id);
      expect(told.edit).toMatchObject({ state: "finished", options: { capture: "bursts" } });
      expect(yield* fs.exists(`${files}/${told.edit?.file}`)).toBe(true);
    }),
  );
});
