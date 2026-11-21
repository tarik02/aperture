import * as UrlPath from "@aperture-browser/shared/url-path";
import { type Address, SessionHttp } from "@aperture-browser/session-client/effect";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Files from "../src/files.ts";
import { read } from "../src/http.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { colourAt } from "../src/video.ts";
import { until } from "../src/wait.ts";

const session = Runner.layer({ features: ["cdp", "recordings"] });

/** A page that is one colour all over. */
const coloured = (colour: string) =>
  `data:text/html,<title>${colour}</title><body style="margin:0;background:${colour}">`;

const JournalEntry = Schema.Struct({
  kind: Schema.String,
  tab: Schema.optional(Schema.Number),
});

suite(session)("a recording that goes on with another tab", (it) => {
  let address: Address;
  let first: Runner.Target;
  let second: Runner.Target;
  let recording: SessionHttp.Recording;
  let stopped: SessionHttp.Recording;

  it.effect("a session has a tab for each page opened in it", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      address = { url: runner.url, token: runner.token };
      first = (yield* runner.targets)[0]!;
      const cdp = yield* runner.cdp;
      const page = yield* cdp.attach(first.id);
      yield* page.call("Page.navigate", { url: coloured("red") });
      yield* cdp.call("Target.createTarget", { url: coloured("blue") });
      second = yield* until(
        "the second tab",
        runner.targets.pipe(Effect.map((all) => all.find((target) => target.id !== first.id))),
      );
      expect(second.tab).not.toBe(first.tab);

      yield* SessionHttp.setViewport(address, second.tab, { width: 800, height: 600 });
      yield* until(
        "the second tab taking its size",
        runner.targets.pipe(
          Effect.map((all) =>
            all.some(
              (target) => target.id === second.id && target.width === 800 && target.height === 600,
            ),
          ),
        ),
      );
    }),
  );

  it.effect("a recording starts on the tab it is asked for", () =>
    Effect.gen(function* () {
      recording = yield* SessionHttp.startRecording(address, { tab: first.tab });
      expect(recording.tab).toBe(first.tab);
      expect(recording.state).toBe("recording");
      // The first tab's part of the video needs some length to be looked into.
      yield* Effect.sleep("2 seconds");
    }),
  );

  it.effect("a caption is taken over HTTP, and an annotation that is none is refused", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const captioned = yield* runner.request("POST", "/recordings/annotations/caption", {
        text: "first",
      });
      expect(captioned.status).toBe(204);
      const unknown = yield* runner.request("POST", "/recordings/annotations/nothing", {});
      expect(unknown.status).toBe(400);
    }),
  );

  it.effect("a tab that is none is refused", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const refused = yield* runner.request(
        "POST",
        UrlPath.make`/recordings/${recording.id}/retarget`,
        {
          tab: 99,
        },
      );
      expect(refused.status).toBe(404);
    }),
  );

  it.effect("the recording goes on with the second tab, which keeps the size it has", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const moved = yield* SessionHttp.retargetRecording(address, recording.id, second.tab);
      expect(moved.tab).toBe(second.tab);
      expect(moved.state).toBe("recording");

      const sized = (yield* runner.targets).find((target) => target.id === second.id);
      expect(sized).toMatchObject({ width: 800, height: 600 });
    }),
  );

  it.effect("retargeting to the tab it is on does nothing", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const again = yield* runner.request(
        "POST",
        UrlPath.make`/recordings/${recording.id}/retarget`,
        {
          tab: second.tab,
        },
      );
      expect(again.status).toBe(200);
      const told = yield* read(again, Schema.Struct({ tab: Schema.Number }));
      expect(told.tab).toBe(second.tab);
      // The second tab's part of the video needs some length too.
      yield* Effect.sleep("2500 millis");
    }),
  );

  it.effect("it stops, and a stopped recording is not retargeted", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      stopped = yield* SessionHttp.stopRecording(address, recording.id);
      expect(stopped.failure).toBeNull();
      expect(stopped.state).toBe("finished");

      const late = yield* runner.request(
        "POST",
        UrlPath.make`/recordings/${recording.id}/retarget`,
        {
          tab: first.tab,
        },
      );
      expect(late.status).toBe(409);
    }),
  );

  it.effect("the video starts on the first tab and ends on the second", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const video = `${runner.files}/${stopped.file}`;
      const seconds = stopped.duration_ms! / 1000;
      expect(yield* colourAt(video, 0)).toBe("red");
      expect(yield* colourAt(video, seconds - 0.5)).toBe("blue");
    }),
  );

  it.effect("the edit is made of both tabs", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const edit = yield* until(
        "the edit being made",
        SessionHttp.getRecording(address, recording.id).pipe(
          Effect.map(({ edit }) => (edit === null || edit.state === "editing" ? undefined : edit)),
        ),
        "1 minute",
      );
      expect(edit).toMatchObject({ state: "finished", failure: null });

      const edited = `${runner.files}/${edit.file}`;
      const seconds = stopped.duration_ms! / 1000;
      expect(yield* colourAt(edited, 0.3)).toBe("red");
      expect(yield* colourAt(edited, seconds - 0.5)).toBe("blue");
    }),
  );

  it.effect("the journal says when it went on with the second tab", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const journal = yield* Files.journal(`${runner.files}/${stopped.journal}`, JournalEntry);
      const retargets = journal.filter((entry) => entry.kind === "retarget");
      expect(retargets.map((entry) => entry.tab)).toEqual([second.tab]);
      expect(journal.some((entry) => entry.kind === "caption")).toBe(true);
    }),
  );
});
