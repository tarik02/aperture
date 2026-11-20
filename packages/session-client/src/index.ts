import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type {
  Recording,
  RecordingAnnotation,
  Screenshot,
  StartRecording,
  StorageState,
  StorageStateAsked,
  Uploaded,
  UploadProgress,
  ViewportSize,
} from "./http.ts";
import type { Surfaces } from "./input.ts";
import type {
  ClipboardEvent,
  ClipboardForm,
  Failure,
  LeaseAction,
  PointerMark,
  Snapshot,
  StrokePhase,
  StrokePoint,
} from "./model.ts";
import {
  type ConnectOptions,
  type Destination,
  type FitOptions,
  type GoOptions,
  make,
  type PictureChange,
} from "./session.ts";

export { SessionError } from "./errors.ts";
export type {
  Recording,
  RecordingAnnotation,
  RecordingBurst,
  RecordingEdit,
  RecordingOptions,
  Screenshot,
  StartRecording,
  StateCookie,
  StorageState,
  StorageStateAsked,
  Uploaded,
  UploadProgress,
  ViewportSize,
} from "./http.ts";
export type { Surfaces } from "./input.ts";
export type {
  Along,
  ClipboardEvent,
  ClipboardForm,
  Connection,
  Download,
  DownloadState,
  Failure,
  Features,
  Grant,
  FileRequest,
  HeldTab,
  LeaseAction,
  PointerMark,
  StrokePhase,
  StrokePoint,
  Member,
  Menu,
  Picture,
  PictureSettings,
  PictureWay,
  Presence,
  Role,
  Snapshot,
  Target,
  VideoFormat,
  VideoQuality,
  VideoStatus,
} from "./model.ts";
export type {
  ConnectOptions,
  Destination,
  FitOptions,
  GoOptions,
  PictureChange,
} from "./session.ts";

/**
 * One session, watched and controlled. Its requests reject with `SessionError`; what goes
 * over the session socket is not answered, and shows in the snapshot when it took effect.
 */
export interface Session {
  /** Referentially stable until something changes. */
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;

  /** Watches a tab, named by its number. */
  readonly select: (tab: number) => void;
  readonly go: (to: Destination, options?: GoOptions) => void;
  readonly newTab: () => void;
  readonly closeTab: (tab: number) => void;
  /**
   * `fit` has the watched target's viewport follow the attached stage's size. With
   * `whenFree` the fitting waits until the tab is this member's to size: until it holds the
   * tab, or nobody holds it and nobody else watches it.
   */
  readonly setViewport: (viewport: ViewportSize | "fit", options?: FitOptions) => void;
  /** Gives the watched target another scale and leaves its size, fitted or not, as it is. */
  readonly setScale: (scale: number) => void;
  /**
   * Changes how the picture comes. A key that is left out keeps what it has; one that is
   * there and undefined leaves the choice to the session again.
   */
  readonly setPicture: (change: PictureChange) => void;
  /**
   * Mutes a tab for this client, or lets it be heard again. A tab is heard while it is
   * watched, once the browser lets a page play sound: after the first click or key.
   */
  readonly setMuted: (tab: number, muted: boolean) => void;
  readonly lease: (action: LeaseAction) => void;
  /**
   * Shows the picture in `video` or `canvas`, whichever `picture.way` needs, and takes
   * the pointer, the wheel, the keyboard, input methods, the clipboard and what is
   * dropped on them. Gives what detaches them. One set of surfaces at a time.
   */
  readonly attach: (surfaces: Surfaces) => () => void;
  /** Gives the keyboard to the session, as a click on the picture does. */
  readonly focus: () => void;
  readonly dismissMenu: () => void;
  /** Asks for a picture the watched page shows; it comes as what the session copied. */
  readonly copyPicture: (url: string) => void;
  /** Puts content on the session's clipboard, for a paste there to take. */
  readonly writeClipboard: (forms: readonly ClipboardForm[]) => void;
  /**
   * What is copied in the session. This browser's clipboard was offered it before the
   * listener hears of it, and `written` tells whether it took it.
   */
  readonly onClipboard: (listener: (event: ClipboardEvent) => void) => () => void;
  /**
   * What this client asked for with `go`, `closeTab`, `copyPicture` or `chooseFiles` and
   * the session did not do, with the reason.
   */
  readonly onFailure: (listener: (failure: Failure) => void) => () => void;
  /** Where the other members' pointers are on the watched tab, as they move. */
  readonly onPointer: (listener: (pointer: PointerMark) => void) => () => void;
  /** The strokes the other members draw over the watched tab, point by point. */
  readonly onStroke: (listener: (point: StrokePoint) => void) => () => void;
  /** Follows a member to whichever tab it watches; nobody when left out. */
  readonly follow: (member?: number) => void;
  /** Shows the others a point of a stroke over the watched tab, in its logical pixels. */
  readonly draw: (
    stroke: number,
    phase: StrokePhase,
    at: { readonly x: number; readonly y: number },
  ) => void;
  /**
   * Pastes into the session: the forms given, or what this browser's clipboard has where
   * a page may read it. False when there was nothing to paste.
   */
  readonly paste: (forms?: readonly ClipboardForm[]) => Promise<boolean>;
  /** Copies what is selected in the session; it comes as what the session copied. */
  readonly copySelection: () => void;
  readonly selectAll: () => void;
  /**
   * Puts content on this browser's clipboard from a click, for what the session copied
   * and the clipboard did not take by itself: text is copied, a picture opens to be
   * copied by hand.
   */
  readonly copyHere: (forms: readonly ClipboardForm[]) => Promise<boolean>;

  readonly upload: (
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ) => Promise<Uploaded>;
  readonly uploads: () => Promise<Uploaded[]>;
  readonly removeUpload: (name: string) => Promise<void>;
  /** Answers a page's request for files with uploads, by name; with none it is dismissed. */
  readonly chooseFiles: (request: number, names: readonly string[]) => void;
  /** An authenticated URL of one of the session's files, such as `downloads/<name>`. */
  readonly fileUrl: (path: string) => string;
  /** The tab as it looks now; `width` asks for a smaller picture, that many pixels wide. */
  readonly screenshotUrl: (tab: number, width?: number) => string;
  readonly recordings: {
    readonly list: () => Promise<Recording[]>;
    readonly get: (id: string) => Promise<Recording>;
    readonly start: (options?: StartRecording) => Promise<Recording>;
    readonly stop: (id: string) => Promise<Recording>;
    /** Has a running recording go on with another tab. */
    readonly retarget: (id: string, tab: number) => Promise<Recording>;
    /** Adds an annotation to the recording named, or to the only one that runs. */
    readonly annotate: (annotation: RecordingAnnotation, id?: string) => Promise<void>;
  };
  /** The cookies and local storage of the session's browser, for whoever runs the session. */
  readonly storageState: {
    readonly export: (asked?: StorageStateAsked) => Promise<StorageState>;
    readonly import: (state: StorageState) => Promise<void>;
  };
  readonly screenshots: {
    readonly list: () => Promise<Screenshot[]>;
    /** Takes one of a tab, the newest when none is named, and keeps it in the files. */
    readonly take: (tab?: number) => Promise<Screenshot>;
  };
  /** Ends the session's client: what is attached, the picture, the sound, the socket. */
  readonly close: () => void;
}

const promised = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Connects to a session at once; the snapshot tells how far the connection is. */
export const connect = (options: ConnectOptions): Session => {
  const scope = Scope.makeUnsafe();
  const session = Effect.runSync(Scope.provide(make(options), scope));

  return {
    getSnapshot: session.store.get,
    subscribe: session.store.subscribe,
    select: (tab) => Effect.runSync(session.select(tab)),
    go: (to, given) => Effect.runSync(session.go(to, given)),
    newTab: () => Effect.runSync(session.newTab),
    closeTab: (tab) => Effect.runSync(session.closeTab(tab)),
    setViewport: (viewport, options) => Effect.runSync(session.setViewport(viewport, options)),
    setScale: (scale) => Effect.runSync(session.setScale(scale)),
    setPicture: (change) => Effect.runSync(session.setPicture(change)),
    setMuted: (tab, muted) => Effect.runSync(session.setMuted(tab, muted)),
    lease: (action) => Effect.runSync(session.lease(action)),
    attach: (surfaces) => {
      const attached = Scope.forkUnsafe(scope);
      Effect.runSync(Scope.provide(session.attach(surfaces), attached));
      return () => Effect.runSync(Scope.close(attached, Exit.void));
    },
    focus: () => Effect.runSync(session.focus),
    dismissMenu: () => Effect.runSync(session.dismissMenu),
    copyPicture: (url) => Effect.runSync(session.copyPicture(url)),
    writeClipboard: (forms) => Effect.runSync(session.writeClipboard(forms)),
    onClipboard: session.onClipboard,
    onFailure: session.onFailure,
    onPointer: session.onPointer,
    onStroke: session.onStroke,
    follow: (member) => Effect.runSync(session.follow(member)),
    draw: (stroke, phase, at) => Effect.runSync(session.draw(stroke, phase, at)),
    paste: (forms) => promised(session.paste(forms)),
    copySelection: () => Effect.runSync(session.copySelection),
    selectAll: () => Effect.runSync(session.selectAll),
    copyHere: (forms) => promised(session.copyHere(forms)),
    upload: (file, onProgress) => promised(session.upload(file, onProgress)),
    uploads: () => promised(session.uploads),
    removeUpload: (name) => promised(session.removeUpload(name)),
    chooseFiles: (request, names) => Effect.runSync(session.chooseFiles(request, names)),
    fileUrl: session.fileUrl,
    screenshotUrl: session.screenshotUrl,
    recordings: {
      list: () => promised(session.recordings.list),
      get: (id) => promised(session.recordings.get(id)),
      start: (started) => promised(session.recordings.start(started)),
      stop: (id) => promised(session.recordings.stop(id)),
      retarget: (id, tab) => promised(session.recordings.retarget(id, tab)),
      annotate: (annotation, id) => promised(session.recordings.annotate(annotation, id)),
    },
    storageState: {
      export: (asked) => promised(session.storageState.export(asked)),
      import: (state) => promised(session.storageState.import(state)),
    },
    screenshots: {
      list: () => promised(session.screenshots.list),
      take: (tab) => promised(session.screenshots.take(tab)),
    },
    close: () => {
      Effect.runFork(Scope.close(scope, Exit.void));
    },
  };
};
