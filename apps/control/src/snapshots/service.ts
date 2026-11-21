import type { Caller } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  NodeRefused,
  NodeUnreachable,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
} from "../errors.ts";
import type { Snapshot } from "./schemas.ts";
import type { SnapshotDescription } from "./store.ts";

/** Snapshots of sessions, wherever they were taken. */
export interface SnapshotsShape {
  /** Takes a snapshot of the caller's session, on the node the session is on. */
  readonly take: (
    caller: Caller,
    sessionId: string,
    options: {
      readonly name: string | undefined;
      readonly description: string | undefined;
      readonly tags: ReadonlyArray<string>;
    },
  ) => Effect.Effect<Snapshot, SessionNotFound | SessionHasNoNode | NodeUnreachable | NodeRefused>;
  /** The caller's own snapshots; all of them for an admin. */
  readonly list: (caller: Caller) => Effect.Effect<ReadonlyArray<Snapshot>>;
  readonly get: (caller: Caller, id: string) => Effect.Effect<Snapshot, SnapshotNotFound>;
  /** Changes what a snapshot is called, said to be and tagged with; what is left out stays. */
  readonly describe: (
    caller: Caller,
    id: string,
    said: SnapshotDescription,
  ) => Effect.Effect<Snapshot, SnapshotNotFound>;
  /**
   * Deletes the snapshot where it is kept, and its record. Sessions created from it keep
   * working. One whose node is forgotten, and that no other node finds, is only forgotten.
   */
  readonly delete: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<void, SnapshotNotFound | NodeUnreachable | NodeRefused>;
}

export class Snapshots extends Context.Service<Snapshots, SnapshotsShape>()(
  "@aperture-browser/control/Snapshots",
) {}
