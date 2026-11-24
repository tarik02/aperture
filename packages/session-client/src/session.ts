import * as UrlPath from "@aperture-browser/shared/url-path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type Address,
  faviconUrl,
  fileUrl,
  previewUrl,
  screenshotUrl,
  socketUrl,
} from "./address.ts";
import * as Clipboard from "./clipboard.ts";
import { CODECS, decodable, waysHere } from "./codecs.ts";
import type { SessionError } from "./errors.ts";
import type { Tile, VideoFrame } from "./gen/aperture/live/v1/live_pb.ts";
import * as Http from "./http.ts";
import * as Input from "./input.ts";
import { KEY, makeKeyboard } from "./keys.ts";
import {
  ALONGS,
  type Along,
  type ClipboardEvent,
  type ClipboardForm,
  downloadOf,
  type Failure,
  failureOf,
  fileRequestOf,
  formatOf,
  FORMATS,
  LEASE_ACTIONS,
  type LeaseAction,
  PAGE_MODES,
  type PageMode,
  menuOf,
  type Picture,
  type PictureSettings,
  type PointerMark,
  pointerOf,
  STROKE_PHASE,
  type StrokePhase,
  type StrokePoint,
  strokeOf,
  type Target,
  type PictureWay,
  PIXELS,
  featuresOf,
  type Pace,
  paceOf,
  NO_FEATURES,
  presenceOf,
  QUALITIES,
  type Snapshot,
  statusOf,
  targetOf,
  type VideoFormat,
} from "./model.ts";
import * as Socket from "./socket.ts";
import * as Sound from "./sound.ts";
import { makeSurface } from "./surface.ts";

export interface ConnectOptions extends Address {
  /** The way the picture is to come at first; the best this browser can do when left out. */
  readonly pixels?: PictureWay | undefined;
}

/** Where the watched target's page is taken. */
export type Destination = { readonly url: string } | { readonly along: Along };

export interface GoOptions {
  /** The page opens in a new tab rather than in the target's. */
  readonly newTab?: boolean | undefined;
}

/**
 * A change of how the picture comes. A key that is left out keeps what it has; one that
 * is there and undefined leaves the choice to the session again.
 */
export interface PictureChange extends PictureSettings {
  readonly way?: PictureWay;
}

/** The snapshot as a store, as `useSyncExternalStore` takes one. */
export interface SnapshotStore {
  /** Referentially stable until something changes. */
  readonly get: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface FitOptions {
  /**
   * Fit only once the tab is this member's to size: it holds the tab, or nobody holds it
   * and nobody else watches it. Without it the fitting is the member's own doing and takes
   * the tab as any input does.
   */
  readonly whenFree?: boolean;
}

export interface SessionService {
  readonly store: SnapshotStore;
  readonly snapshot: Effect.Effect<Snapshot>;
  /** The snapshot as it is, then every snapshot after it. */
  readonly changes: Stream.Stream<Snapshot>;
  /** What is copied in the session, after this browser's clipboard was offered it. */
  readonly clipboard: Stream.Stream<ClipboardEvent>;
  readonly onClipboard: (listener: (event: ClipboardEvent) => void) => () => void;
  /** What this client asked for and the session did not do. */
  readonly failures: Stream.Stream<Failure>;
  readonly onFailure: (listener: (failure: Failure) => void) => () => void;
  /**
   * A finger moved the watched tab's page, by this much of the target's pixels each time:
   * down the page where `y` is more than nothing. It tells what the finger did, whether
   * or not the page had anywhere to go.
   */
  readonly onDragged: (
    listener: (by: { readonly x: number; readonly y: number }) => void,
  ) => () => void;
  /** Where the other members' pointers are on the watched tab, as they move. */
  readonly onPointer: (listener: (pointer: PointerMark) => void) => () => void;
  /** The strokes the other members draw over the watched tab, point by point. */
  readonly onStroke: (listener: (point: StrokePoint) => void) => () => void;
  /**
   * Follows a member to whichever tab it watches, until this client selects a tab itself;
   * nobody when left out.
   */
  readonly follow: (member?: number) => Effect.Effect<void>;
  /**
   * Shows the others a point of a stroke over the watched tab, in the tab's logical
   * pixels. The client numbers its strokes.
   */
  readonly draw: (
    stroke: number,
    phase: StrokePhase,
    at: { readonly x: number; readonly y: number },
  ) => Effect.Effect<void>;
  /**
   * Shows the others where this client's pointer is over the watched tab while it gives
   * the tab no input, as while it draws; nowhere when left out.
   */
  readonly point: (at?: { readonly x: number; readonly y: number }) => Effect.Effect<void>;

  readonly select: (tab: number) => Effect.Effect<void>;
  readonly go: (to: Destination, options?: GoOptions) => Effect.Effect<void>;
  readonly newTab: Effect.Effect<void>;
  readonly closeTab: (tab: number) => Effect.Effect<void>;
  /**
   * `fit` has the watched target's viewport follow the attached stage's size. With
   * `whenFree` the fitting waits its turn, see [`FitOptions`].
   */
  readonly setViewport: (
    viewport: Http.ViewportSize | "fit",
    options?: FitOptions,
  ) => Effect.Effect<void>;
  /** Gives the watched target another scale and leaves its size, fitted or not, as it is. */
  readonly setScale: (scale: number) => Effect.Effect<void>;
  /** Sets how the watched tab's pages are shown, for a member that holds the tab. */
  readonly setMode: (mode: PageMode) => Effect.Effect<void>;
  readonly setPicture: (change: PictureChange) => Effect.Effect<void>;
  /**
   * Mutes a tab for this client, or lets it be heard again. A tab is heard while it is
   * watched, once the browser lets a page play sound: after the first click or key.
   */
  readonly setMuted: (tab: number, muted: boolean) => Effect.Effect<void>;
  readonly lease: (action: LeaseAction) => Effect.Effect<void>;
  /**
   * Shows the picture in the surfaces and takes their input, until the scope closes. One
   * set of surfaces at a time.
   */
  readonly attach: (surfaces: Input.Surfaces) => Effect.Effect<void, never, Scope.Scope>;
  /** Gives the keyboard to the session, as a click on the picture does. */
  readonly focus: Effect.Effect<void>;
  readonly dismissMenu: Effect.Effect<void>;
  /** Asks for a picture the watched page shows; it comes as what the session copied. */
  readonly copyPicture: (url: string) => Effect.Effect<void>;
  /** Puts content on the session's clipboard, for a paste there to take. */
  readonly writeClipboard: (forms: readonly ClipboardForm[]) => Effect.Effect<void>;
  /**
   * Pastes into the session: the forms given, or what this browser's clipboard has where
   * a page may read it. False when there was nothing to paste.
   */
  readonly paste: (forms?: readonly ClipboardForm[]) => Effect.Effect<boolean>;
  /** Copies what is selected in the session; it comes as what the session copied. */
  readonly copySelection: Effect.Effect<void>;
  readonly selectAll: Effect.Effect<void>;
  /**
   * Puts content on this browser's clipboard from a click, for what the session copied
   * and the clipboard did not take by itself: text is copied, a picture opens to be
   * copied by hand.
   */
  readonly copyHere: (forms: readonly ClipboardForm[]) => Effect.Effect<boolean>;

  readonly upload: (
    file: File,
    onProgress?: (progress: Http.UploadProgress) => void,
  ) => Effect.Effect<Http.Uploaded, SessionError>;
  readonly uploads: Effect.Effect<Http.Uploaded[], SessionError>;
  readonly removeUpload: (name: string) => Effect.Effect<void, SessionError>;
  /** Answers a page's request for files with uploads, by name; with none it is dismissed. */
  readonly chooseFiles: (request: number, names: readonly string[]) => Effect.Effect<void>;
  /** An authenticated URL of one of the session's files, such as `downloads/<name>`. */
  readonly fileUrl: (path: string) => string;
  /** The target as it looks now; `width` asks for a smaller picture, that many pixels wide. */
  readonly screenshotUrl: (tab: number, width?: number) => string;
  /** The target as it looked a moment ago, small: for a list of the tabs. */
  readonly previewUrl: (tab: number) => string;
  /**
   * The icon of the target's page, which the session fetches as its browser does anything
   * else of the page: the page's site is told nothing of who watches. None for a page
   * that is not of the web.
   */
  readonly faviconUrl: (target: Target) => string | undefined;
  readonly recordings: {
    readonly list: Effect.Effect<Http.Recording[], SessionError>;
    readonly get: (id: string) => Effect.Effect<Http.Recording, SessionError>;
    readonly start: (options?: Http.StartRecording) => Effect.Effect<Http.Recording, SessionError>;
    /** Stops a recording; its edit is made with `options`. */
    readonly stop: (
      id: string,
      options?: Http.EditRecording,
    ) => Effect.Effect<Http.Recording, SessionError>;
    /** Makes the edit of a stopped recording again, with other options. */
    readonly edit: (
      id: string,
      options?: Http.EditRecording,
    ) => Effect.Effect<Http.Recording, SessionError>;
    /** Has a running recording go on with another tab. */
    readonly retarget: (id: string, tab: number) => Effect.Effect<Http.Recording, SessionError>;
    /** Adds an annotation to the recording named, or to the only one that runs. */
    readonly annotate: (
      annotation: Http.RecordingAnnotation,
      id?: string,
    ) => Effect.Effect<void, SessionError>;
  };
  /** The cookies and local storage of the session's browser, for whoever runs the session. */
  readonly storageState: {
    readonly export: (
      asked?: Http.StorageStateAsked,
    ) => Effect.Effect<Http.StorageState, SessionError>;
    readonly import: (state: Http.StorageState) => Effect.Effect<void, SessionError>;
  };
  /**
   * How the session's automation moves the pointer in what is recorded. The snapshot's
   * `pace` tells it as it is set, by anyone.
   */
  readonly pace: {
    readonly get: Effect.Effect<Pace, SessionError>;
    readonly set: (pace: Pace) => Effect.Effect<Pace, SessionError>;
  };
  readonly screenshots: {
    readonly list: Effect.Effect<Http.Screenshot[], SessionError>;
    /** Takes one of a target, the newest when none is named, and keeps it in the files. */
    readonly take: (tab?: number) => Effect.Effect<Http.Screenshot, SessionError>;
  };
}

/** A WebRTC connection that says nothing for this long is taken not to connect. */
const RTC_CONNECTS_WITHIN = "8 seconds";

/**
 * What frames are asked for when the choice is left to this client: sharp color where
 * frames are decoded here. Over WebRTC the session picks what every browser takes.
 */
const BEST_FRAMES: readonly VideoFormat[] = ["full-chroma", "h264"];

/** How long sound that was sent before a tab was to be heard keeps arriving. */
const SOUND_SETTLES_MS = 300;

const pixels = (side: number) => Math.max(0, Math.round(side));

/** The widest the shorter side of a phone's window is, in CSS pixels. */
const PHONE_WITHIN = 600;
/**
 * The most pixels a page shown as on a phone draws to one of its own, unless it is given
 * another scale: a phone's screen has three and more, and a picture of that many is three
 * times the video of one of two, which reads as well on a screen that small.
 */
const SHARPEST = 2;

/**
 * Whether this is a phone: a finger is what points, and the window is narrow. A tablet
 * and a laptop with a touch screen are none.
 */
const onPhone = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches &&
  Math.min(window.innerWidth, window.innerHeight) <= PHONE_WITHIN;

/**
 * Connects to a session. Closing the scope unwires what is attached, ends the picture's
 * WebRTC connection and decoder, then the sound, then the session socket.
 */
export const make = Effect.fn("Session.make")(function* (options: ConnectOptions) {
  const address: Address = { url: options.url, token: options.token, name: options.name };
  const ways = waysHere();

  let way = ways[Math.max(0, ways.indexOf(options.pixels ?? "video"))] ?? "tiles";
  let settings: PictureSettings = {};
  let closed = false;
  let sounds = false;
  let fitting = false;
  let attached: Input.Surfaces | undefined;
  let menuAt = { x: 0, y: 0 };

  let snapshot: Snapshot = {
    connection: { state: "connecting" },
    targets: [],
    selected: undefined,
    presence: undefined,
    downloads: [],
    fileRequests: [],
    cursor: "default",
    picture: { way, ways, status: undefined, formats: [], settings, rtc: undefined },
    features: NO_FEATURES,
    pace: "fast",
    muted: [],
    menu: undefined,
    fit: false,
    phone: onPhone(),
  };
  const listeners = new Set<() => void>();
  const clipboardListeners = new Set<(event: ClipboardEvent) => void>();

  // What the session tells again as it was leaves the snapshot the one it is.
  const update = (change: Partial<Snapshot>) => {
    const changed = Object.entries(change).filter(
      ([key, value]) => !Equal.equals(snapshot[key as keyof Snapshot], value),
    );
    if (changed.length === 0) {
      return;
    }
    snapshot = { ...snapshot, ...Object.fromEntries(changed) };
    for (const listener of listeners) {
      listener();
    }
  };
  const updatePicture = (change: Partial<Picture>) => {
    update({ picture: { ...snapshot.picture, ...change } });
  };
  const listening =
    <A>(listeners: Set<(value: A) => void>) =>
    (listener: (value: A) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
  const subscribe = listening(listeners);
  const onClipboard = listening(clipboardListeners);
  const draggedListeners = new Set<(by: { readonly x: number; readonly y: number }) => void>();
  const onDragged = listening(draggedListeners);
  const failureListeners = new Set<(failure: Failure) => void>();
  const onFailure = listening(failureListeners);
  const pointerListeners = new Set<(pointer: PointerMark) => void>();
  const strokeListeners = new Set<(point: StrokePoint) => void>();
  const watched = () => snapshot.targets.find((target) => target.tab === snapshot.selected);

  const socket = yield* Socket.open(socketUrl(address), {
    opened: () => {
      update({ connection: { state: "open" } });
      socket.send({ case: "device", value: { phone: snapshot.phone } });
      runFork(start());
    },
    message: (message) => receive(message),
    closed: (reason) => {
      update({
        connection: reason === undefined ? { state: "closed" } : { state: "closed", reason },
      });
      // A picture that comes on a connection of its own would go on without the session.
      runFork(stop());
    },
  });
  const sound = yield* Sound.make();
  const surface = makeSurface();
  const scope = yield* Effect.scope;
  // Whatever brings the picture now lives below this, and ends before the sound does.
  const pictureScope = yield* Scope.fork(scope);
  const runFork = yield* FiberSet.makeRuntime<never, void, never>();

  interface Peer {
    readonly connection: RTCPeerConnection;
    /** Carries pointer motion apart from everything else. */
    readonly pointer: RTCDataChannel;
  }
  let peer: Peer | undefined;
  let stream: MediaStream | undefined;
  let decoder: VideoDecoder | undefined;
  let decodes: VideoFormat | undefined;
  let wayScope: Scope.Closeable | undefined;
  // Counts the times the picture was started, for what was awaited to tell it is stale.
  let turns = 0;

  const send = (message: Socket.Outgoing) => {
    const pointer = peer?.pointer;
    if (message.case === "pointerMotion" && pointer?.readyState === "open") {
      pointer.send(new Uint8Array(Socket.encode(message)));
      return;
    }
    socket.send(message);
  };

  const keyboard = makeKeyboard((code, pressed) => send({ case: "key", value: { code, pressed } }));

  /** Says how the picture is to come: again whenever something changes that. */
  const hello = Effect.fn("Session.hello")(function* () {
    const asked = way;
    const decoded = yield* Effect.tryPromise(() => decodable(asked)).pipe(
      Effect.orElseSucceed((): VideoFormat[] => []),
    );
    if (closed || asked !== way) {
      return;
    }
    if (settings.format !== undefined && !decoded.includes(settings.format)) {
      const { format: _, ...kept } = settings;
      settings = kept;
    }
    updatePicture({ formats: decoded, settings });
    const best = asked === "frames" ? BEST_FRAMES.filter((format) => decoded.includes(format)) : [];
    const wanted = settings.format === undefined ? best : [settings.format];
    send({
      case: "hello",
      value: {
        pixels: PIXELS[asked],
        formats: wanted.map((format) => FORMATS[format]),
        quality: settings.quality === undefined ? undefined : QUALITIES[settings.quality],
        fps: settings.fps,
        // With a WebRTC connection the sound comes on a track of that.
        audio: sounds && asked !== "video",
      },
    });
  });

  const closeDecoder = () => {
    if (decoder !== undefined && decoder.state !== "closed") {
      decoder.close();
    }
    decoder = undefined;
    decodes = undefined;
  };

  /** What fails falls to the next way: video over WebRTC, the same video as frames, tiles. */
  const fall = (reason: string) => {
    const failed = way;
    const next = ways[ways.indexOf(failed) + 1];
    if (closed || next === undefined || !socket.isOpen()) {
      return;
    }
    way = next;
    runFork(Effect.logWarning(`${failed}: ${reason}`).pipe(Effect.andThen(start())));
  };

  const watchVideo = Effect.fn("Session.watchVideo")(function* (
    turn: number,
    within: Scope.Closeable,
  ) {
    const connection = yield* Effect.acquireRelease(
      Effect.sync(() => new RTCPeerConnection()),
      (made) =>
        Effect.sync(() => {
          made.close();
          if (peer?.connection === made) {
            peer = undefined;
          }
          stream = undefined;
          sound.track(undefined);
          if (attached !== undefined) {
            attached.video.srcObject = null;
          }
        }),
    ).pipe(Scope.provide(within));
    connection.addTransceiver("video", { direction: "recvonly" });
    connection.addTransceiver("audio", { direction: "recvonly" });
    // A move that is lost is not worth waiting for: the next one says where the pointer is.
    const pointer = connection.createDataChannel("pointer", { ordered: true, maxRetransmits: 0 });
    peer = { connection, pointer };

    connection.addEventListener("track", (event) => {
      if (event.track.kind === "audio") {
        sound.track(event.track);
        return;
      }
      // Frames are shown as they come: one that waits to be smoothed is one seen late.
      const receiver: RTCRtpReceiver & { playoutDelayHint?: number } = event.receiver;
      receiver.jitterBufferTarget = 0;
      receiver.playoutDelayHint = 0;
      stream = new MediaStream([event.track]);
      if (attached !== undefined) {
        attached.video.srcObject = stream;
      }
    });
    connection.addEventListener("connectionstatechange", () => {
      if (peer?.connection !== connection) {
        return;
      }
      updatePicture({ rtc: connection.connectionState });
      if (connection.connectionState === "failed") {
        fall("WebRTC failed");
      }
    });

    const offer = yield* Effect.tryPromise(async () => {
      await connection.setLocalDescription(await connection.createOffer());
      return connection.localDescription?.sdp;
    }).pipe(Effect.result);
    if (closed || turn !== turns) {
      return;
    }
    if (Result.isFailure(offer) || offer.success === undefined) {
      const cause = Result.isFailure(offer) ? offer.failure.cause : undefined;
      fall(cause instanceof Error ? cause.message : "WebRTC made no offer");
      return;
    }
    send({ case: "rtcOffer", value: { sdp: offer.success } });

    // A network that drops its packets says nothing.
    const waiting = runFork(
      Effect.sleep(RTC_CONNECTS_WITHIN).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (turn === turns && connection.connectionState !== "connected") {
              fall("WebRTC did not connect");
            }
          }),
        ),
      ),
    );
    yield* Scope.addFinalizer(
      within,
      Effect.sync(() => waiting.interruptUnsafe()),
    );
  });

  /** Ends however the picture comes. */
  const stop = Effect.fn("Session.stop")(function* () {
    turns += 1;
    const before = wayScope;
    wayScope = undefined;
    if (before !== undefined) {
      yield* Scope.close(before, Exit.void);
    }
  });

  /** Starts the picture the way it is to come, in place of however it came before. */
  const start: () => Effect.Effect<void> = Effect.fn("Session.start")(function* () {
    yield* stop();
    const turn = turns;
    if (closed) {
      return;
    }
    const within = yield* Scope.fork(pictureScope);
    wayScope = within;
    updatePicture({ way, status: undefined, rtc: undefined });
    yield* Scope.addFinalizer(within, Effect.sync(closeDecoder));
    yield* hello();
    if (closed || turn !== turns || way !== "video") {
      return;
    }
    yield* watchVideo(turn, within);
  });

  const answer = (sdp: string) => {
    const connection = peer?.connection;
    if (connection === undefined) {
      return;
    }
    connection.setRemoteDescription({ type: "answer", sdp }).catch((cause: unknown) => {
      if (peer?.connection === connection) {
        fall(cause instanceof Error ? cause.message : "WebRTC took no answer");
      }
    });
  };

  const shown = (timeUs: bigint) => send({ case: "videoShown", value: { timeUs } });

  const decodeFrame = (frame: VideoFrame) => {
    const format = formatOf(frame.format);
    const takes = frame.tab === snapshot.selected && way === "frames";
    // A frame let go is told too: the session counts on hearing of every frame.
    if (!takes || format === undefined || typeof VideoDecoder === "undefined") {
      shown(frame.timeUs);
      return;
    }
    if (decoder?.state !== "configured" || decodes !== format) {
      if (!frame.keyframe) {
        shown(frame.timeUs);
        return;
      }
      closeDecoder();
      const made = new VideoDecoder({
        output: (picture) => {
          surface.draw(picture, 0, 0, picture.displayWidth, picture.displayHeight);
          shown(BigInt(picture.timestamp));
          picture.close();
        },
        error: (error) => {
          if (decoder === made) {
            fall(error.message);
          }
        },
      });
      made.configure({ codec: CODECS[format], optimizeForLatency: true });
      decoder = made;
      decodes = format;
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: frame.keyframe ? "key" : "delta",
          timestamp: Number(frame.timeUs),
          data: frame.data,
        }),
      );
    } catch (cause) {
      shown(frame.timeUs);
      fall(cause instanceof Error ? cause.message : "a frame was not decoded");
    }
  };

  // Tiles are drawn in the order they came: each is a part of the picture before it.
  const tiles = yield* Queue.unbounded<Tile>();
  const drawTile = Effect.fnUntraced(function* (tile: Tile) {
    const image = yield* Effect.tryPromise(() =>
      createImageBitmap(new Blob([new Uint8Array(tile.png)], { type: "image/png" })),
    ).pipe(
      Effect.catch((cause) =>
        // The part of the picture stays as it was until a tile covers it again.
        Effect.sync(() => console.warn("A tile of the session's picture was not decoded", cause)),
      ),
    );
    if (image === undefined) {
      return;
    }
    if (tile.tab === snapshot.selected && way === "tiles") {
      surface.draw(image, tile.x, tile.y, tile.width, tile.height);
    }
    image.close();
  });
  runFork(Effect.forever(Queue.take(tiles).pipe(Effect.flatMap(drawTile))));

  /** What the session copied goes to the clipboard here, where the browser lets it. */
  const copied = (forms: readonly ClipboardForm[]) => {
    if (forms.length === 0) {
      return;
    }
    runFork(
      Effect.promise(() => Clipboard.write(forms)).pipe(
        Effect.andThen((written) =>
          Effect.sync(() => {
            for (const listener of clipboardListeners) {
              listener({ forms, written });
            }
          }),
        ),
      ),
    );
  };

  const receive = (message: Socket.Incoming) => {
    take(message);
    follow();
    tune();
  };

  let unmuting: ReturnType<typeof setTimeout> | undefined;

  /** Hears the watched tab unless it is muted here, and stops hearing as that changes. */
  const tune = () => {
    const target = watched();
    const on =
      snapshot.features.sound.read && target !== undefined && !snapshot.muted.includes(target.tab);
    if (on === sounds) {
      return;
    }
    sounds = on;
    clearTimeout(unmuting);
    if (on) {
      // What is on its way is still the sound of the tab watched before, or of this one
      // from before it was to be heard: it is let pass, unheard.
      unmuting = setTimeout(() => sound.turn(sounds), SOUND_SETTLES_MS);
    } else {
      sound.turn(false);
    }
    if (way !== "video" && socket.isOpen()) {
      runFork(hello());
    }
  };

  const take = (message: Socket.Incoming) => {
    switch (message.case) {
      case "rtcAnswer": {
        answer(message.value.sdp);
        break;
      }
      case "rtcRefused": {
        fall(message.value.reason);
        break;
      }
      case "videoStatus": {
        updatePicture({ status: statusOf(message.value) });
        break;
      }
      case "failed": {
        const failure = failureOf(message.value);
        for (const listener of failureListeners) {
          listener(failure);
        }
        break;
      }
      case "pointer": {
        const pointer = pointerOf(message.value);
        for (const listener of pointerListeners) {
          listener(pointer);
        }
        break;
      }
      case "stroke": {
        const point = strokeOf(message.value);
        if (point !== undefined) {
          for (const listener of strokeListeners) {
            listener(point);
          }
        }
        break;
      }
      case "features": {
        update({ features: featuresOf(message.value) });
        break;
      }
      case "paced": {
        update({ pace: paceOf(message.value.pace) });
        break;
      }
      case "presence": {
        update({ presence: presenceOf(message.value) });
        break;
      }
      case "menu": {
        update({ menu: { ...menuOf(message.value), ...menuAt } });
        break;
      }
      case "clipboard": {
        copied(message.value.forms.map(({ type, data }) => ({ type, data })));
        break;
      }
      case "downloads": {
        update({ downloads: message.value.downloads.map(downloadOf) });
        break;
      }
      case "fileRequests": {
        update({ fileRequests: message.value.requests.map(fileRequestOf) });
        break;
      }
      case "tile": {
        if (typeof createImageBitmap !== "undefined") {
          Queue.offerUnsafe(tiles, message.value);
        }
        break;
      }
      case "audio": {
        if (way !== "video") {
          sound.hear(message.value.timeUs, message.value.data);
        }
        break;
      }
      case "videoFrame": {
        decodeFrame(message.value);
        break;
      }
      case "targets": {
        update({ targets: message.value.targets.map(targetOf) });
        break;
      }
      case "selected": {
        update({ selected: message.value.tab });
        break;
      }
      case "cursor": {
        const { cursor } = message.value;
        const named = cursor.case === "named" && cursor.value !== "" ? cursor.value : "default";
        update({ cursor: cursor.case === "hidden" ? "none" : named });
        break;
      }
    }
  };

  /**
   * Whether the watched tab is this member's to size without being asked to: it holds the
   * tab, or nobody holds it and nobody else watches it. A tab has one size for everyone, so
   * a window that merely opens or changes its size does not take the tab from those at work
   * in it.
   */
  const free = () => {
    const target = watched();
    if (target === undefined) {
      return false;
    }
    const presence = snapshot.presence;
    if (presence === undefined) {
      return true;
    }
    const held = presence.held.find((one) => one.tab === target.tab);
    if (held !== undefined) {
      return held.holder === presence.you;
    }
    return !presence.members.some((one) => one.id !== presence.you && one.tab === target.tab);
  };

  /**
   * The target that was last fitted because it was this member's to size, and whether it
   * was shown as on a phone then: it is fitted another way once that changes.
   */
  let followed: string | undefined;

  /** Fits the watched target once it becomes this member's to size, and each one that does. */
  const follow = () => {
    const target = watched();
    const mine =
      fitting && target !== undefined && free() ? `${target.tab} ${target.mobile}` : undefined;
    if (mine === followed) {
      return;
    }
    followed = mine;
    if (mine !== undefined) {
      fit(false);
    }
  };

  /**
   * Gives the watched target the size of the stage, while the viewport is to fit it.
   * `unasked` is for what no one chose just now, such as the window changing its size.
   */
  const fit = (unasked: boolean) => {
    const target = watched();
    if (!fitting || attached === undefined || target === undefined) {
      return;
    }
    if (unasked && !free()) {
      return;
    }
    const { clientWidth, clientHeight } = attached.stage;
    if (clientWidth <= 0 || clientHeight <= 0) {
      return;
    }
    if (target.mobile) {
      // A phone's page has the size of a phone: of this one, where this is one, each of
      // its pixels as many of the screen's as the screen has, up to what is worth sending.
      if (snapshot.phone) {
        const scale = Math.min(Math.max(window.devicePixelRatio, 1), SHARPEST);
        send({ case: "viewport", value: { width: clientWidth, height: clientHeight, scale } });
      } else if (target.mode === "auto") {
        // A tab that goes by its holder is a desktop's once this member holds it, and is
        // fitted then. One that was set to be a phone's keeps the size it has.
        send({ case: "lease", value: { action: LEASE_ACTIONS.take } });
      }
      return;
    }
    // A stage narrower than a browser's window gets has a page of its shape, shown
    // smaller: one of the stage's height would leave bands above and below it.
    const widened = Math.max(1, NARROWEST / clientWidth);
    send({
      case: "viewport",
      value: {
        width: Math.round(clientWidth * widened),
        height: Math.round(clientHeight * widened),
      },
    });
  };

  const listed = async (files: readonly File[]) => {
    const put = await Promise.all(
      files.map((file) => Effect.runPromise(Http.upload(address, file))),
    );
    const uris = put.map((file) => {
      return `${UrlPath.make`file://${UrlPath.segments(file.path)}`}\r\n`;
    });
    return Clipboard.textForm("text/uri-list", uris.join(""));
  };

  const wiring: Input.Wiring = {
    send,
    keyboard,
    way: () => way,
    watched,
    listed,
    menuAt: (at) => {
      menuAt = at;
    },
    dismissMenu: () => update({ menu: undefined }),
    dragged: (by) => {
      for (const listener of draggedListeners) {
        listener(by);
      }
    },
    resized: () => fit(true),
    failed: (what, cause) => {
      runFork(Effect.logWarning(`${what} did not reach the session`, cause));
    },
  };

  const attach = Effect.fn("Session.attach")(function* (surfaces: Input.Surfaces) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        attached = surfaces;
        surface.attach(surfaces.canvas);
        // The sound plays apart from the picture, and a video with sound waits for a click.
        surfaces.video.muted = true;
        surfaces.video.autoplay = true;
        surfaces.video.playsInline = true;
        surfaces.video.srcObject = stream ?? null;
      }),
      () =>
        Effect.sync(() => {
          surfaces.video.srcObject = null;
          if (attached === surfaces) {
            attached = undefined;
            surface.detach();
          }
        }),
    );
    yield* Input.wire(surfaces, wiring);
  });

  const paste = Effect.fn("Session.paste")(function* (given?: readonly ClipboardForm[]) {
    const forms =
      given ??
      (yield* Effect.tryPromise(() => Clipboard.read()).pipe(
        Effect.orElseSucceed((): ClipboardForm[] => []),
      ));
    if (forms.length === 0) {
      return false;
    }
    send({ case: "clipboard", value: { forms: [...forms] } });
    keyboard.chord(KEY.v);
    return true;
  });

  const setPicture = (change: PictureChange) => {
    const { way: asked, ...changed } = change;
    settings = { ...settings, ...changed };
    updatePicture({ settings });
    if (!socket.isOpen()) {
      // The picture starts with these once the socket opens.
      if (asked !== undefined && ways.includes(asked)) {
        way = asked;
        updatePicture({ way });
      }
      return;
    }
    if (asked !== undefined && asked !== way && ways.includes(asked)) {
      way = asked;
      runFork(start());
      return;
    }
    runFork(hello());
  };

  // What this client is used from changes as its window does: a phone turned on its side
  // is still one, a window made narrow under a mouse is none.
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const coarse = window.matchMedia("(pointer: coarse)");
    const looked = () => {
      const phone = onPhone();
      if (phone === snapshot.phone) {
        return;
      }
      update({ phone });
      socket.send({ case: "device", value: { phone } });
      followed = undefined;
      follow();
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        window.addEventListener("resize", looked);
        coarse.addEventListener("change", looked);
      }),
      () =>
        Effect.sync(() => {
          window.removeEventListener("resize", looked);
          coarse.removeEventListener("change", looked);
        }),
    );
  }

  // Registered last, so that it runs first: nothing that ends after it starts anything.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      clearTimeout(unmuting);
      // A socket that closed by itself has said why.
      if (snapshot.connection.state !== "closed") {
        update({ connection: { state: "closed" } });
      }
      update({ menu: undefined });
    }),
  );

  return {
    store: { get: () => snapshot, subscribe },
    snapshot: Effect.sync(() => snapshot),
    changes: Stream.callback<Snapshot>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerUnsafe(queue, snapshot);
          return subscribe(() => Queue.offerUnsafe(queue, snapshot));
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    ),
    clipboard: Stream.callback<ClipboardEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => onClipboard((event) => Queue.offerUnsafe(queue, event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    ),
    onClipboard,
    failures: Stream.callback<Failure>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => onFailure((failure) => Queue.offerUnsafe(queue, failure))),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    ),
    onFailure,
    onDragged,
    onPointer: listening(pointerListeners),
    onStroke: listening(strokeListeners),
    follow: (member) =>
      Effect.sync(() =>
        send({
          case: "follow",
          value: member === undefined ? {} : { member: BigInt(member) },
        }),
      ),
    draw: (stroke, phase, at) =>
      Effect.sync(() =>
        send({ case: "draw", value: { stroke, phase: STROKE_PHASE[phase], x: at.x, y: at.y } }),
      ),
    point: (at) =>
      Effect.sync(() => send({ case: "pointing", value: at === undefined ? {} : { at } })),

    select: (tab) => Effect.sync(() => send({ case: "select", value: { tab } })),
    go: (to, { newTab = false } = {}) =>
      Effect.sync(() => {
        const destination =
          "url" in to
            ? { case: "url" as const, value: to.url }
            : { case: "along" as const, value: ALONGS[to.along] };
        send({ case: "go", value: { to: destination, newTab } });
      }),
    newTab: Effect.sync(() =>
      send({ case: "go", value: { to: { case: "url", value: "" }, newTab: true } }),
    ),
    closeTab: (tab) => Effect.sync(() => send({ case: "close", value: { tab } })),
    setViewport: (viewport, options) =>
      Effect.sync(() => {
        fitting = viewport === "fit";
        update({ fit: fitting });
        if (viewport === "fit") {
          followed = undefined;
          if (options?.whenFree === true) {
            follow();
          } else {
            fit(false);
          }
          return;
        }
        const { width, height, scale } = viewport;
        send({ case: "viewport", value: { width: pixels(width), height: pixels(height), scale } });
      }),
    setScale: (scale) =>
      Effect.sync(() => {
        const target = watched();
        if (target !== undefined) {
          const { width, height } = target;
          send({ case: "viewport", value: { width, height, scale } });
        }
      }),
    setMode: (mode) =>
      Effect.sync(() => send({ case: "setMode", value: { mode: PAGE_MODES[mode] } })),
    setPicture: (change) => Effect.sync(() => setPicture(change)),
    setMuted: (tab, muted) =>
      Effect.sync(() => {
        const others = snapshot.muted.filter((one) => one !== tab);
        update({ muted: muted ? [...others, tab] : others });
        tune();
      }),
    lease: (action) =>
      Effect.sync(() => send({ case: "lease", value: { action: LEASE_ACTIONS[action] } })),
    attach,
    focus: Effect.sync(() => attached?.keys.focus({ preventScroll: true })),
    dismissMenu: Effect.sync(() => update({ menu: undefined })),
    copyPicture: (url) => Effect.sync(() => send({ case: "copyPicture", value: { url } })),
    writeClipboard: (forms) =>
      Effect.sync(() => send({ case: "clipboard", value: { forms: [...forms] } })),
    paste,
    copySelection: Effect.sync(() => keyboard.chord(KEY.c)),
    selectAll: Effect.sync(() => keyboard.chord(KEY.a)),
    copyHere: (forms) => Effect.promise(() => Clipboard.writeByHand(forms)),

    upload: (file, onProgress) => Http.upload(address, file, onProgress),
    uploads: Http.uploads(address),
    removeUpload: (name) => Http.removeUpload(address, name),
    chooseFiles: (request, names) =>
      Effect.sync(() =>
        send({ case: "filesChosen", value: { id: BigInt(request), files: [...names] } }),
      ),
    fileUrl: (path) => fileUrl(address, path),
    screenshotUrl: (tab, width) => screenshotUrl(address, tab, width),
    previewUrl: (tab) => previewUrl(address, tab),
    faviconUrl: (target) => {
      const site = /^https?:\/\/[^/?#]+/u.exec(target.url)?.[0];
      return site === undefined ? undefined : faviconUrl(address, target.tab, site);
    },
    recordings: {
      list: Http.listRecordings(address),
      get: (id) => Http.getRecording(address, id),
      start: (started) => Http.startRecording(address, started),
      stop: (id, options) => Http.stopRecording(address, id, options),
      edit: (id, options) => Http.editRecording(address, id, options),
      retarget: (id, tab) => Http.retargetRecording(address, id, tab),
      annotate: (annotation, id) => Http.annotateRecording(address, annotation, id),
    },
    storageState: {
      export: (asked) => Http.exportStorageState(address, asked),
      import: (state) => Http.importStorageState(address, state),
    },
    pace: {
      get: Http.getPace(address),
      set: (pace) => Http.setPace(address, pace),
    },
    screenshots: {
      list: Http.listScreenshots(address),
      take: (tab) => Http.takeScreenshot(address, tab),
    },
  } satisfies SessionService;
});

/** One session's client, for programs that pass it along as a service. */
export class Session extends Context.Service<Session, SessionService>()(
  "@aperture-browser/session-client/Session",
) {}

/** Connects to a session for as long as the layer lives. */
export const layer = (options: ConnectOptions) => Layer.effect(Session, make(options));
/** The narrowest the session's browser makes a window: asked for less, it stays this wide. */
const NARROWEST = 500;
