import * as UrlPath from "@aperture-browser/shared/url-path";
import * as Effect from "effect/Effect";
import { type Address, headers, route } from "./address.ts";
import { SessionError } from "./errors.ts";
import type { Pace, Target } from "./model.ts";

/** A file put into the session for its browser to take. */
export interface Uploaded {
  readonly name: string;
  readonly size: number;
  /** Where the file is, for the browser as for the session's tools. */
  readonly path: string;
}

/** A download as the session's `downloads` route tells it. */
export interface DownloadedFile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly received: number;
  /** None while the page does not say. */
  readonly total: number | null;
  readonly state: "running" | "done" | "failed";
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
  /** The target keeps its scale when left out. */
  readonly scale?: number | undefined;
}

/** The size of a burst around a tool call, see `RecordingOptions.capture`. */
export interface RecordingBurst {
  readonly lead_ms: number;
  readonly tail_ms: number;
  /** The tail goes on until the picture has stood still for this long. */
  readonly settle_ms: number;
  readonly max_tail_ms: number;
}

/**
 * How an edit of a recording is made: said as the recording stops, and again for every edit
 * that is made of it after.
 */
export interface RecordingOptions {
  /** `bursts` keeps only the stretches around what the automation did. */
  readonly capture: "continuous" | "bursts";
  /** Shortens the stretches in which nothing happens. Not with `bursts`. */
  readonly idle: "cut" | "speed" | null;
  /** Marks clicks with a ripple. */
  readonly ripple: boolean;
  readonly burst: RecordingBurst;
  /** The share of the picture that must change for something to have happened: 0 to 1. */
  readonly motion_threshold: number;
  /** The edited video's frames a second: 1 to 60, which is the most the raw video has. */
  readonly fps: number;
}

/** What is said of an edit; what is left out is as the session has it by default. */
export interface EditRecording extends Partial<Omit<RecordingOptions, "burst">> {
  readonly burst?: Partial<RecordingBurst>;
}

export interface StartRecording {
  /** The tab to record; the newest one when left out. */
  readonly tab?: number;
  /** Go on with whichever tab the session's automation acts on. */
  readonly follow?: boolean;
}

export interface RecordingEdit {
  readonly state: "editing" | "finished" | "failed";
  /** What it is made with: what the recording was stopped or last edited again with. */
  readonly options: RecordingOptions;
  /** When it was made, which tells one edit of a recording from the one before. */
  readonly made_at_ms: number | null;
  /** The edited video's file, relative to the session's files, once it is made. */
  readonly file: string | null;
  /** What happened, where in the raw video and where in the edited one. */
  readonly timeline: string | null;
  readonly failure: string | null;
}

export interface Recording {
  readonly id: string;
  /** The tab it is of. */
  readonly tab: number;
  /** The target it is of, which is no target of a later run of the session. */
  readonly target: string;
  /** The page's title and address as the recording began. */
  readonly title: string;
  readonly url: string;
  /** The raw video's file, relative to the session's files. */
  readonly file: string;
  /** The journal's file, relative to the session's files. */
  readonly journal: string;
  /** A small picture of the target as the recording began, relative to the session's files. */
  readonly preview: string | null;
  readonly journal_dropped: number;
  readonly state: "recording" | "finished" | "failed";
  readonly started_at_ms: number;
  /** Set once the recording ended. */
  readonly duration_ms: number | null;
  readonly bytes: number | null;
  readonly failure: string | null;
  /** It goes on with whichever tab the session's automation acts on. */
  readonly follow: boolean;
  /** The edit, once the recording stopped; none where the session cannot make one. */
  readonly edit: RecordingEdit | null;
}

/** A picture of a target, kept in the session's files. */
export interface Screenshot {
  readonly id: string;
  /** The page's title and address as it was taken. */
  readonly title: string;
  readonly url: string;
  /** The picture's size in pixels. */
  readonly width: number;
  readonly height: number;
  /** The picture's file, relative to the session's files. */
  readonly file: string;
  /** The same picture, small. */
  readonly preview: string;
  readonly bytes: number;
  readonly taken_at_ms: number;
}

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
}

interface Request {
  readonly method?: string;
  readonly json?: unknown;
}

const failed = (cause: unknown) =>
  new SessionError({
    message: cause instanceof Error ? cause.message : "the session could not be reached",
    cause,
  });

const refused = (status: number, text: string) =>
  new SessionError({ message: text === "" ? `the session answered ${status}` : text, status });

const request = Effect.fnUntraced(function* (address: Address, path: string, asked: Request = {}) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(route(address, path), {
        method: asked.method ?? "GET",
        headers: {
          ...headers(address),
          ...(asked.json === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: asked.json === undefined ? null : JSON.stringify(asked.json),
        signal,
      }),
    catch: failed,
  });
  if (!response.ok) {
    const text = yield* Effect.tryPromise({ try: () => response.text(), catch: failed });
    return yield* refused(response.status, text);
  }
  return response;
});

// The session's own answers are trusted to have the shape its routes give them.
const json = <A>(address: Address, path: string, asked?: Request) =>
  request(address, path, asked).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({ try: () => response.json() as Promise<A>, catch: failed }),
    ),
  );

const named = (name: string) => UrlPath.make`/uploads/${name}`;

// `fetch` does not tell how much of a body it has sent.
const uploadTold = (address: Address, file: File, onProgress: (progress: UploadProgress) => void) =>
  Effect.callback<Uploaded, SessionError>((resume) => {
    const sending = new XMLHttpRequest();
    sending.open("PUT", route(address, named(file.name)));
    for (const [name, value] of Object.entries(headers(address))) {
      sending.setRequestHeader(name, value);
    }
    sending.upload.addEventListener("progress", (event) => {
      onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : file.size });
    });
    sending.addEventListener("error", () => {
      resume(Effect.fail(new SessionError({ message: "the session could not be reached" })));
    });
    sending.addEventListener("load", () => {
      if (sending.status < 200 || sending.status >= 300) {
        resume(Effect.fail(refused(sending.status, sending.responseText)));
        return;
      }
      resume(
        Effect.try({ try: () => JSON.parse(sending.responseText) as Uploaded, catch: failed }),
      );
    });
    sending.send(file);
    return Effect.sync(() => sending.abort());
  });

/** Every target of the session, oldest first. */
export const targets = Effect.fn("SessionHttp.targets")((address: Address) =>
  json<Target[]>(address, "/targets"),
);

/** Gives a target its own viewport, as near to the one asked for as it can be given. */
export const setViewport = Effect.fn("SessionHttp.setViewport")(
  (address: Address, tab: number, viewport: ViewportSize) =>
    request(address, UrlPath.make`/targets/${tab}/viewport`, {
      method: "PUT",
      json: viewport,
    }).pipe(Effect.asVoid),
);

export const downloads = Effect.fn("SessionHttp.downloads")((address: Address) =>
  json<DownloadedFile[]>(address, "/downloads"),
);

export const uploads = Effect.fn("SessionHttp.uploads")((address: Address) =>
  json<Uploaded[]>(address, "/uploads"),
);

/**
 * Puts a file into the session's uploads under its own name, in place of one there was.
 * Files get to the session's browser this way: they are put there, and the browser is
 * told where they are.
 */
export const upload = Effect.fn("SessionHttp.upload")(function* (
  address: Address,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
) {
  if (onProgress !== undefined && typeof XMLHttpRequest !== "undefined") {
    return yield* uploadTold(address, file, onProgress);
  }
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(route(address, named(file.name)), {
        method: "PUT",
        headers: headers(address),
        body: file,
        signal,
      }),
    catch: failed,
  });
  const text = yield* Effect.tryPromise({ try: () => response.text(), catch: failed });
  if (!response.ok) {
    return yield* refused(response.status, text);
  }
  const uploaded = yield* Effect.try({ try: () => JSON.parse(text) as Uploaded, catch: failed });
  onProgress?.({ loaded: uploaded.size, total: uploaded.size });
  return uploaded;
});

export const removeUpload = Effect.fn("SessionHttp.removeUpload")(
  (address: Address, name: string) =>
    request(address, named(name), { method: "DELETE" }).pipe(Effect.asVoid),
);

export const listRecordings = Effect.fn("SessionHttp.listRecordings")((address: Address) =>
  json<Recording[]>(address, "/recordings"),
);

export const getRecording = Effect.fn("SessionHttp.getRecording")((address: Address, id: string) =>
  json<Recording>(address, UrlPath.make`/recordings/${id}`),
);

export const startRecording = Effect.fn("SessionHttp.startRecording")(
  (address: Address, options: StartRecording = {}) =>
    json<Recording>(address, "/recordings", { method: "POST", json: options }),
);

/** Stops a recording. Its edit is made after, with `options`. */
export const stopRecording = Effect.fn("SessionHttp.stopRecording")(
  (address: Address, id: string, options: EditRecording = {}) =>
    json<Recording>(address, UrlPath.make`/recordings/${id}/stop`, {
      method: "POST",
      json: options,
    }),
);

/**
 * Makes the edit of a stopped recording again, of the same raw video and with `options`. It
 * takes the place of the edit there is once it is made. Refused while an edit of the
 * recording is being made, and for a recording whose raw video is gone.
 */
export const editRecording = Effect.fn("SessionHttp.editRecording")(
  (address: Address, id: string, options: EditRecording = {}) =>
    json<Recording>(address, UrlPath.make`/recordings/${id}/edit`, {
      method: "POST",
      json: options,
    }),
);

export const getPace = Effect.fn("SessionHttp.getPace")((address: Address) =>
  json<{ readonly pace: Pace }>(address, "/pace").pipe(Effect.map((told) => told.pace)),
);

/** Sets the session's pace, for every recording and whoever watches. */
export const setPace = Effect.fn("SessionHttp.setPace")((address: Address, pace: Pace) =>
  json<{ readonly pace: Pace }>(address, "/pace", { method: "PUT", json: { pace } }).pipe(
    Effect.map((told) => told.pace),
  ),
);

/** Has a running recording go on with another tab, in the same video. */
export const retargetRecording = Effect.fn("SessionHttp.retargetRecording")(
  (address: Address, id: string, tab: number) =>
    json<Recording>(address, UrlPath.make`/recordings/${id}/retarget`, {
      method: "POST",
      json: { tab },
    }),
);

/** What a running recording's edit is told to show. */
export type RecordingAnnotation =
  | { readonly kind: "caption"; readonly text: string; readonly duration_ms?: number }
  | {
      readonly kind: "focus";
      readonly zoom: number;
      readonly rect?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly selector?: string;
      readonly pointer?: boolean;
      /** Zooms out after this long; until `reset_focus` when left out. */
      readonly duration_ms?: number;
    }
  | { readonly kind: "reset_focus" }
  | {
      readonly kind: "attention";
      readonly x?: number;
      readonly y?: number;
      readonly selector?: string;
      readonly radius?: number;
      readonly loops?: number;
      readonly duration_ms?: number;
    };

/** Adds an annotation to a running recording: the one named, or the only one that runs. */
export const annotateRecording = Effect.fn("SessionHttp.annotateRecording")((
  address: Address,
  annotation: RecordingAnnotation,
  id?: string,
) => {
  const { kind, ...given } = annotation;
  return request(address, UrlPath.make`/recordings/annotations/${kind}`, {
    method: "POST",
    json: id === undefined ? given : { ...given, id },
  }).pipe(Effect.asVoid);
});

/** A cookie of the session's browser. */
export interface StateCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  /** It goes to this host alone, not to the hosts below it. */
  readonly hostOnly?: boolean;
  readonly path: string;
  /** Seconds since the epoch; a cookie without it ends with the browser. */
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
  readonly partitionKey?: unknown;
}

/**
 * What the session's browser keeps for the sites it visits: cookies, local storage and,
 * where they were asked for, the origins' IndexedDB databases.
 */
export interface StorageState {
  readonly cookies?: readonly StateCookie[];
  readonly origins?: readonly {
    readonly origin: string;
    readonly localStorage?: readonly { readonly name: string; readonly value: string }[];
    /** The origin's databases, as the session wrote them down. */
    readonly indexedDB?: readonly unknown[];
  }[];
}

/** Which of it an export gives. */
export interface StorageStateAsked {
  /** The origins of the pages the tabs show, or the origins named. */
  readonly origins?: "open-tabs" | readonly string[];
  /** The cookies the browser would send to those origins, or all it has. */
  readonly cookies?: "matching" | "all";
  /** The origins' IndexedDB databases as well, where many sites keep who is signed in. */
  readonly indexed_db?: boolean;
}

/** Takes cookies and the storage of origins out of the session's browser. */
export const exportStorageState = Effect.fn("SessionHttp.exportStorageState")(
  (address: Address, asked: StorageStateAsked = {}) =>
    json<StorageState>(address, "/storage-state", { method: "POST", json: asked }),
);

/**
 * Puts cookies and the storage of origins into the session's browser: the cookies beside
 * those there are, each origin's local storage in place of what the origin had, and each
 * of its databases in place of the origin's one of that name.
 */
export const importStorageState = Effect.fn("SessionHttp.importStorageState")(
  (address: Address, state: StorageState) =>
    request(address, "/storage-state", { method: "PUT", json: state }).pipe(Effect.asVoid),
);

export const listScreenshots = Effect.fn("SessionHttp.listScreenshots")((address: Address) =>
  json<Screenshot[]>(address, "/screenshots"),
);

/** Takes a screenshot of a tab, the newest one when none is named, and keeps it. */
export const takeScreenshot = Effect.fn("SessionHttp.takeScreenshot")(
  (address: Address, tab?: number) =>
    json<Screenshot>(address, "/screenshots", { method: "POST", json: { tab } }),
);
