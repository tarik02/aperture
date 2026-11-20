import * as pb from "./gen/aperture/live/v1/live_pb.ts";

/** How the picture of the watched target reaches the client. */
export type PictureWay = "video" | "frames" | "tiles";

/** The form a target's video takes; see `VideoFormat` in the protocol. */
export type VideoFormat = "h264" | "full-chroma" | "h265" | "vp9" | "vp9-full-chroma" | "av1";

/** How much the video costs the link; see `VideoQuality` in the protocol. */
export type VideoQuality = "low" | "medium" | "full";

export type Role = "view" | "control" | "admin";

export type DownloadState = "running" | "done" | "failed";

export type Along = "back" | "forward" | "reload";

export type LeaseAction = "take" | "release" | "allow" | "keep";

/** A page of the session's browser. */
export interface Target {
  /** Lasts as long as the page does in one run of the session. */
  readonly id: string;
  /** The tab's number, which stays the tab's when the session is suspended and resumed. */
  readonly tab: number;
  readonly title: string;
  readonly url: string;
  /** In logical pixels, which pointer positions are in. */
  readonly width: number;
  readonly height: number;
  /** Pixels to a logical pixel. */
  readonly scale: number;
  /** The tab plays sound now. */
  readonly sounds: boolean;
  /** The page's history has somewhere to go back to, and forward. */
  readonly goesBack: boolean;
  readonly goesForward: boolean;
}

/** What this client may do in one area of the session. */
export interface Grant {
  readonly read: boolean;
  readonly write: boolean;
}

/**
 * What this client may do in the session, area by area: what whoever let it in gave it, of
 * what the session offers at all. Watching takes no grant.
 */
export interface Features {
  /** Write: giving the watched tab input. */
  readonly input: Grant;
  /** Write: opening, closing and navigating tabs, and giving them another size. */
  readonly tabs: Grant;
  /** Write: taking a tab from whoever holds it, without asking. */
  readonly lease: Grant;
  /** Read: hearing tabs. */
  readonly sound: Grant;
  /** Read: what is copied in the session. Write: pasting into it. */
  readonly clipboard: Grant;
  /** Read: the files put into the session. Write: putting them, and answering pages. */
  readonly uploads: Grant;
  /** Read: what the session's browser downloaded. */
  readonly downloads: Grant;
  /** Read: recordings and screenshots. Write: making them. */
  readonly recordings: Grant;
  /** Write: the automation endpoint. */
  readonly mcp: Grant;
  /** Write: the DevTools endpoint. */
  readonly cdp: Grant;
  /** Write: attaching a tunnel. */
  readonly tunnel: Grant;
}

const NOTHING: Grant = { read: false, write: false };

/** What a client may do before the session has told: nothing. */
export const NO_FEATURES: Features = {
  input: NOTHING,
  tabs: NOTHING,
  lease: NOTHING,
  sound: NOTHING,
  clipboard: NOTHING,
  uploads: NOTHING,
  downloads: NOTHING,
  recordings: NOTHING,
  mcp: NOTHING,
  cdp: NOTHING,
  tunnel: NOTHING,
};

const grantOf = (grant: pb.Grant | undefined): Grant =>
  grant === undefined ? NOTHING : { read: grant.read, write: grant.write };

export const featuresOf = (features: pb.Features): Features => ({
  input: grantOf(features.input),
  tabs: grantOf(features.tabs),
  lease: grantOf(features.lease),
  sound: grantOf(features.sound),
  clipboard: grantOf(features.clipboard),
  uploads: grantOf(features.uploads),
  downloads: grantOf(features.downloads),
  recordings: grantOf(features.recordings),
  mcp: grantOf(features.mcp),
  cdp: grantOf(features.cdp),
  tunnel: grantOf(features.tunnel),
});

export interface Member {
  readonly id: number;
  readonly name: string;
  readonly role: Role | undefined;
  /** The tab the member watches. */
  readonly tab: number | undefined;
  /** The session's automation rather than a person. */
  readonly agent: boolean;
  /** The member this one follows: it watches the tab that member watches. */
  readonly follows: number | undefined;
}

/** Where another member's pointer is on the watched tab, in the tab's logical pixels. */
export interface PointerMark {
  readonly member: number;
  /** None once the pointer left the tab's picture. */
  readonly at: { readonly x: number; readonly y: number } | undefined;
}

export type StrokePhase = "start" | "move" | "end";

/** A point of a stroke another member draws over the watched tab. */
export interface StrokePoint {
  readonly member: number;
  /** Which of the member's strokes the point is of. */
  readonly stroke: number;
  readonly phase: StrokePhase;
  readonly x: number;
  readonly y: number;
}

export interface HeldTab {
  readonly tab: number;
  /** The member who holds it. */
  readonly holder: number;
  /** The member who asks the holder for it. */
  readonly askedBy: number | undefined;
}

/** Who is in the session and who drives which tab. */
export interface Presence {
  /** The member this client is. */
  readonly you: number;
  readonly members: readonly Member[];
  readonly held: readonly HeldTab[];
}

export interface Download {
  readonly id: string;
  /** The file's name below `downloads/` of the session's files. */
  readonly name: string;
  readonly url: string;
  readonly receivedBytes: number;
  /** Left out while the page does not say. */
  readonly totalBytes: number | undefined;
  readonly state: DownloadState | undefined;
}

/** A page that asks for files and has no answer yet. */
export interface FileRequest {
  readonly id: number;
  /** The tab whose page asks. */
  readonly tab: number;
  readonly multiple: boolean;
}

/** What a right click in the session was on, when the page showed no menu of its own. */
export interface Menu {
  readonly link: string | undefined;
  readonly image: string | undefined;
  /** The text that is selected. */
  readonly text: string | undefined;
  /** There is a field to write into under the pointer. */
  readonly editable: boolean;
}

/** One form of content that is copied or dragged, by its MIME type. */
export interface ClipboardForm {
  readonly type: string;
  readonly data: Uint8Array;
}

/** Something was copied in the session. */
export interface ClipboardEvent {
  readonly forms: readonly ClipboardForm[];
  /** Whether this browser's clipboard took it; where it did not, a click has to. */
  readonly written: boolean;
}

/** Something this client asked for over the session socket was not done. */
export interface Failure {
  readonly asked: "go" | "close" | "copyPicture" | "chooseFiles" | "follow" | undefined;
  /** Why, as the session says it. */
  readonly reason: string;
}

export interface VideoStatus {
  readonly format: VideoFormat | undefined;
  readonly quality: VideoQuality | undefined;
  /** Frames a second at most. */
  readonly fps: number;
}

export interface PictureSettings {
  readonly format?: VideoFormat;
  readonly quality?: VideoQuality;
  readonly fps?: number;
}

export interface Picture {
  readonly way: PictureWay;
  /** What this browser can do, best first. */
  readonly ways: readonly PictureWay[];
  /** What the session says it sends. */
  readonly status: VideoStatus | undefined;
  /** What this browser can decode the current way. */
  readonly formats: readonly VideoFormat[];
  readonly settings: PictureSettings;
  /** The state of the WebRTC connection while the picture comes as video. */
  readonly rtc: RTCPeerConnectionState | undefined;
}

export interface Connection {
  readonly state: "connecting" | "open" | "closed";
  readonly reason?: string;
}

export interface Snapshot {
  readonly connection: Connection;
  readonly targets: readonly Target[];
  /** The tab that is watched, by its number. */
  readonly selected: number | undefined;
  readonly presence: Presence | undefined;
  readonly downloads: readonly Download[];
  readonly fileRequests: readonly FileRequest[];
  /** A CSS cursor value. */
  readonly cursor: string;
  readonly picture: Picture;
  /** Nothing is granted until the session has told. */
  readonly features: Features;
  /** The numbers of the tabs that are muted here; the others are heard while watched. */
  readonly muted: readonly number[];
  /** The session's right-click report, at the client coordinates of the click. */
  readonly menu: (Menu & { readonly x: number; readonly y: number }) | undefined;
  /** The watched target's viewport follows the attached stage's size. */
  readonly fit: boolean;
}

export const FORMATS = {
  h264: pb.VideoFormat.H264,
  "full-chroma": pb.VideoFormat.FULL_CHROMA,
  h265: pb.VideoFormat.H265,
  vp9: pb.VideoFormat.VP9,
  "vp9-full-chroma": pb.VideoFormat.VP9_FULL_CHROMA,
  av1: pb.VideoFormat.AV1,
} as const satisfies Record<VideoFormat, pb.VideoFormat>;

export const QUALITIES = {
  low: pb.VideoQuality.LOW,
  medium: pb.VideoQuality.MEDIUM,
  full: pb.VideoQuality.FULL,
} as const satisfies Record<VideoQuality, pb.VideoQuality>;

export const PIXELS = {
  video: pb.Pixels.VIDEO,
  frames: pb.Pixels.FRAMES,
  tiles: pb.Pixels.TILES,
} as const satisfies Record<PictureWay, pb.Pixels>;

export const ALONGS = {
  back: pb.Along.BACK,
  forward: pb.Along.FORWARD,
  reload: pb.Along.RELOAD,
} as const satisfies Record<Along, pb.Along>;

export const LEASE_ACTIONS = {
  take: pb.LeaseAction.TAKE,
  release: pb.LeaseAction.RELEASE,
  allow: pb.LeaseAction.ALLOW,
  keep: pb.LeaseAction.KEEP,
} as const satisfies Record<LeaseAction, pb.LeaseAction>;

const ROLES: Partial<Record<pb.Role, Role>> = {
  [pb.Role.VIEW]: "view",
  [pb.Role.CONTROL]: "control",
  [pb.Role.ADMIN]: "admin",
};

const ASKED: Partial<Record<pb.Asked, NonNullable<Failure["asked"]>>> = {
  [pb.Asked.GO]: "go",
  [pb.Asked.CLOSE]: "close",
  [pb.Asked.COPY_PICTURE]: "copyPicture",
  [pb.Asked.FILES_CHOSEN]: "chooseFiles",
  [pb.Asked.FOLLOW]: "follow",
};

const STROKE_PHASES: Partial<Record<pb.StrokePhase, StrokePhase>> = {
  [pb.StrokePhase.START]: "start",
  [pb.StrokePhase.MOVE]: "move",
  [pb.StrokePhase.END]: "end",
};

export const STROKE_PHASE: Record<StrokePhase, pb.StrokePhase> = {
  start: pb.StrokePhase.START,
  move: pb.StrokePhase.MOVE,
  end: pb.StrokePhase.END,
};

export const pointerOf = (pointer: pb.Pointer): PointerMark => ({
  member: Number(pointer.member),
  at: pointer.at === undefined ? undefined : { x: pointer.at.x, y: pointer.at.y },
});

/** None for a point of a phase this client does not know. */
export const strokeOf = (stroke: pb.Stroke): StrokePoint | undefined => {
  const phase = STROKE_PHASES[stroke.phase];
  return phase === undefined
    ? undefined
    : { member: Number(stroke.member), stroke: stroke.stroke, phase, x: stroke.x, y: stroke.y };
};

export const failureOf = (failed: pb.Failed): Failure => ({
  asked: ASKED[failed.asked],
  reason: failed.reason,
});

const DOWNLOAD_STATES: Partial<Record<pb.DownloadState, DownloadState>> = {
  [pb.DownloadState.RUNNING]: "running",
  [pb.DownloadState.DONE]: "done",
  [pb.DownloadState.FAILED]: "failed",
};

const named = <Name extends string>(names: Record<Name, number>, value: number) => {
  const found = Object.entries<number>(names).find(([, one]) => one === value);
  return found?.[0] as Name | undefined;
};

export const formatOf = (format: pb.VideoFormat) => named(FORMATS, format);

export const qualityOf = (quality: pb.VideoQuality) => named(QUALITIES, quality);

// Ids are counters the session starts at one, far below where a double stops being exact.
const count = (id: bigint | undefined) => (id === undefined ? undefined : Number(id));

export const targetOf = (target: pb.Target): Target => ({
  id: target.id,
  tab: target.tab,
  title: target.title,
  url: target.url,
  width: target.width,
  height: target.height,
  scale: target.scale,
  sounds: target.sounds,
  goesBack: target.goesBack,
  goesForward: target.goesForward,
});

export const presenceOf = (presence: pb.Presence): Presence => ({
  you: Number(presence.you),
  members: presence.members.map((member) => ({
    id: Number(member.id),
    name: member.name,
    role: ROLES[member.role],
    tab: member.tab,
    agent: member.agent,
    follows: count(member.follows),
  })),
  held: presence.held.map((held) => ({
    tab: held.tab,
    holder: Number(held.holder),
    askedBy: count(held.askedBy),
  })),
});

export const downloadOf = (download: pb.Download): Download => ({
  id: download.id,
  name: download.name,
  url: download.url,
  receivedBytes: Number(download.receivedBytes),
  totalBytes: count(download.totalBytes),
  state: DOWNLOAD_STATES[download.state],
});

export const fileRequestOf = (request: pb.FileRequest): FileRequest => ({
  id: Number(request.id),
  tab: request.tab,
  multiple: request.multiple,
});

export const menuOf = (menu: pb.Menu): Menu => ({
  link: menu.link,
  image: menu.image,
  text: menu.text,
  editable: menu.editable,
});

export const statusOf = (status: pb.VideoStatus): VideoStatus => ({
  format: formatOf(status.format),
  quality: qualityOf(status.quality),
  fps: status.fps,
});
