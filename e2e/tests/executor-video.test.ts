import * as UrlPath from "@aperture-browser/shared/url-path";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Executor, type ExecutorService } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { type Page, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";

const node = Layer.mergeAll(Node.layer({ features: ["cdp"] }), ViewerLive.layer);

/** A frame of video as the session socket carries it to a client that asked for frames. */
const Frame = Schema.Struct({
  format: Schema.String,
  keyframe: Schema.optional(Schema.Boolean),
  timeUs: Schema.String,
  data: Schema.String,
});
type Frame = typeof Frame.Type;

const Status = Schema.Struct({
  format: Schema.String,
  quality: Schema.String,
  fps: Schema.Number,
});
type Status = typeof Status.Type;

/** What of the session's messages a client that takes frames reads. */
const toldOf = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      videoStatus: Schema.optional(Status),
      videoFrame: Schema.optional(Frame),
    }),
  ),
);

/** A client on the session socket that takes the picture as frames and says when it showed them. */
interface FrameClient {
  /** Says what the client takes: `PIXELS_FRAMES`, with a quality, a rate and formats or without. */
  readonly hello: (asks: object) => Effect.Effect<void>;
  /** Shows every frame this much after it came, as a link that does not keep up does. */
  readonly showLateBy: (lateness: Duration.Duration) => void;
  /** The qualities the session said it sends, in order: `LOW`, `MEDIUM`, `FULL`. */
  readonly qualities: () => readonly string[];
  /** What the session said last of what it sends. */
  readonly status: () => Status | undefined;
  /**
   * Whether the first frame after the last change of quality was a keyframe; undefined
   * while none came.
   */
  readonly keyframeAfterChange: () => boolean | undefined;
  readonly firstFrame: () => Frame | undefined;
  /** How many frames came so far. */
  readonly frames: () => number;
}

const frameClient = Effect.fn("frameClient")(function* (
  executor: ExecutorService,
  session: string,
) {
  const base = executor.url.replace(/^http/u, "ws");
  const socket = yield* Socket.makeWebSocket(
    UrlPath.make`${UrlPath.raw(base)}/sessions/${session}/ws?token=${executor.token}`,
  );
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;

  const qualities: string[] = [];
  let status: Status | undefined;
  let keyframeAfterChange: boolean | undefined;
  let firstFrame: Frame | undefined;
  let frames = 0;
  let lateBy = Duration.zero;

  // To a socket that is closed nothing is said.
  const send = (message: object) => Effect.ignore(writer.write(JSON.stringify(message)));

  const heard = Effect.fn(function* (text: string) {
    const message = yield* toldOf(text);
    if (message.videoStatus !== undefined) {
      status = message.videoStatus;
      qualities.push(status.quality.split("_").at(-1) ?? "");
      keyframeAfterChange = undefined;
    }
    const frame = message.videoFrame;
    if (frame !== undefined) {
      keyframeAfterChange ??= frame.keyframe === true;
      firstFrame ??= frame;
      frames += 1;
      yield* Effect.sleep(lateBy).pipe(
        Effect.andThen(send({ videoShown: { timeUs: frame.timeUs } })),
        Effect.forkScoped,
      );
    }
  });
  yield* reader.pull.pipe(
    Effect.flatMap(
      Effect.forEach(
        (text) => (typeof text === "string" ? Effect.ignore(heard(text)) : Effect.void),
        { discard: true },
      ),
    ),
    Effect.forever,
    Effect.ignore,
    Effect.forkScoped,
  );

  return {
    hello: (asks) => send({ hello: asks }),
    showLateBy: (lateness) => {
      lateBy = lateness;
    },
    qualities: () => qualities,
    status: () => status,
    keyframeAfterChange: () => keyframeAfterChange,
    firstFrame: () => firstFrame,
    frames: () => frames,
  } satisfies FrameClient;
});

/** Something on the page that changes with every frame, so that there is video to send. */
const START_MOVING = `(() => {
  const box = document.body.appendChild(document.createElement("div"));
  box.style.cssText = "position:fixed;right:0;bottom:0;width:400px;height:300px";
  window.moving = setInterval(() => {
    box.style.background = "hsl(" + ((Date.now() / 5) % 360) + " 80% 50%)";
  }, 16);
})()`;

/** What the newest WebRTC connection of a workbench decodes: the codec and how many frames. */
const DECODED = `peers.at(-1).getStats().then((stats) => {
  const inbound = [...stats.values()].find((s) => s.type === "inbound-rtp" && s.kind === "video");
  return inbound
    ? { mime: stats.get(inbound.codecId)?.mimeType ?? "", frames: inbound.framesDecoded ?? 0 }
    : { mime: "", frames: 0 };
})`;

const Decoded = Schema.Struct({ mime: Schema.String, frames: Schema.Number });

/** The formats WebRTC is asked for in turn, and what their codec is called there. */
const OVER_WEBRTC = [
  { format: "vp9", codec: /vp9/iu },
  { format: "vp9-full-chroma", codec: /vp9/iu },
  { format: "av1", codec: /av1/iu },
  { format: "h265", codec: /h265/iu },
  { format: "h264", codec: /h264/iu },
] as const;

suite(node)("the video of a session of a node", (it) => {
  let session: string;
  let opened: Node.Opened;
  let watcher: Page;
  let client: FrameClient;

  /**
   * Waits until the session says it sends a quality and a frame of it came, and tells
   * whether it does.
   */
  const comesTo = (quality: string, withinSeconds: number) =>
    happens(
      Effect.sync(
        () => client.qualities().at(-1) === quality && client.keyframeAfterChange() !== undefined,
      ),
      Duration.seconds(withinSeconds),
    ).pipe(Effect.map(() => client.qualities().at(-1) === quality));

  it.effect("a link that keeps up gets WebRTC video at the best quality", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const viewer = yield* Viewer;
      session = (yield* executor.client.sessions.create()).id;
      opened = yield* Node.open(executor, session, Node.TRIAL_PAGE);
      yield* opened.page.evaluate(START_MOVING);

      watcher = yield* Node.watch(viewer, executor, session);
      const best = yield* happens(
        snapshot(watcher, "s.picture.way === 'video' && s.picture.status?.quality === 'full'"),
        "1 minute",
      );
      expect(best).toBe(true);
    }),
  );

  // A link that does not keep up: a client that shows frames late gets a lower quality,
  // and one that shows them in time a better one.
  it.effect("frames start at the middle quality", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      client = yield* Node.lasting(frameClient(executor, session));
      yield* client.hello({ pixels: "PIXELS_FRAMES" });
      expect(yield* comesTo("MEDIUM", 5)).toBe(true);
    }),
  );

  it.effect("a client that shows frames in time gets the best quality", () =>
    Effect.gen(function* () {
      expect(yield* comesTo("FULL", 12)).toBe(true);
      expect(client.keyframeAfterChange()).toBe(true);
    }),
  );

  it.effect("a client that shows frames late gets a lower quality", () =>
    Effect.gen(function* () {
      client.showLateBy(Duration.millis(700));
      expect(yield* comesTo("MEDIUM", 8)).toBe(true);
    }),
  );

  it.effect("and a lower one still while it stays late", () =>
    Effect.gen(function* () {
      expect(yield* comesTo("LOW", 8)).toBe(true);
      expect(client.keyframeAfterChange()).toBe(true);
    }),
  );

  it.effect("it gets a better quality again once it keeps up", () =>
    Effect.gen(function* () {
      client.showLateBy(Duration.zero);
      expect(yield* comesTo("MEDIUM", 25)).toBe(true);
    }),
  );

  it.effect("a client gets the quality it asks for", () =>
    Effect.gen(function* () {
      yield* client.hello({ pixels: "PIXELS_FRAMES", quality: "VIDEO_QUALITY_LOW" });
      expect(yield* comesTo("LOW", 5)).toBe(true);
    }),
  );

  it.effect("and keeps it whatever its link carries", () =>
    Effect.gen(function* () {
      yield* Effect.sleep("4 seconds");
      expect(client.qualities().at(-1)).toBe("LOW");
    }),
  );

  it.effect("a client gets no more frames a second than it asks for", () =>
    Effect.gen(function* () {
      yield* client.hello({ pixels: "PIXELS_FRAMES", quality: "VIDEO_QUALITY_FULL", fps: 5 });
      yield* comesTo("FULL", 5);
      yield* Effect.sleep("500 millis");

      const before = client.frames();
      yield* Effect.sleep("3 seconds");
      const inThreeSeconds = client.frames() - before;

      expect(client.status()?.fps).toBe(5);
      expect(inThreeSeconds).toBeGreaterThanOrEqual(10);
      expect(inThreeSeconds).toBeLessThanOrEqual(17);
    }),
  );

  // Other codecs: as frames to whoever asks, and over WebRTC where the browser takes them.
  it.effect("frames come in H.265, VP9, VP9 4:4:4 and AV1", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const formats = [
        "VIDEO_FORMAT_H265",
        "VIDEO_FORMAT_VP9",
        "VIDEO_FORMAT_VP9_FULL_CHROMA",
        "VIDEO_FORMAT_AV1",
      ];
      for (const format of formats) {
        const asking = yield* frameClient(executor, session);
        yield* asking.hello({ pixels: "PIXELS_FRAMES", formats: [format] });
        yield* happens(
          Effect.sync(() => asking.firstFrame() !== undefined),
          "10 seconds",
        );

        const first = asking.firstFrame();
        expect(asking.status()?.format, format).toBe(format);
        expect(first?.format, format).toBe(format);
        expect(first?.keyframe, format).toBe(true);
        expect(first?.data.length, format).toBeGreaterThan(100);
      }
    }),
  );

  it.effect("WebRTC video changes codec while it plays", () =>
    Effect.gen(function* () {
      const decodes = yield* snapshot(watcher, "s.picture.formats", Schema.Array(Schema.String));
      expect(decodes.length).toBeGreaterThanOrEqual(3);

      for (const { format, codec } of OVER_WEBRTC) {
        if (!decodes.includes(format)) {
          continue;
        }
        yield* watcher.evaluate(`apertureSession.setPicture({ format: "${format}" })`);

        const plays = yield* happens(
          Effect.gen(function* () {
            const said = yield* snapshot(watcher, "s.picture.status?.format");
            const before = yield* watcher.evaluate(DECODED, Decoded);
            yield* Effect.sleep("500 millis");
            const after = yield* watcher.evaluate(DECODED, Decoded);
            return said === format && after.frames > before.frames && codec.test(after.mime);
          }),
          "45 seconds",
        );
        expect(plays, format).toBe(true);
      }
      yield* watcher.evaluate("apertureSession.setPicture({ format: undefined })");
    }),
  );

  it.effect("the viewer's page threw nothing", () =>
    Effect.sync(() => {
      expect(watcher.errors()).toEqual([]);
    }),
  );
});
