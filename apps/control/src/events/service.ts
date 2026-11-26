import type {
  Caller,
  EventActor,
  EventDetail,
  EventKind,
  EventResource,
} from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Forbidden } from "../errors.ts";
import type { Event } from "./schemas.ts";

/** Something that was done, as whatever did it says it. */
export interface Happened {
  readonly kind: EventKind;
  readonly resource?: EventResource | null;
  /** The account what it was about is of, or was done to. */
  readonly ownerId?: string | null;
  readonly workspaceId?: string | null;
  /**
   * Whether of those in its workspace, its admins alone read it: what is said of one of its
   * members is theirs and the admins' to know.
   */
  readonly adminsOnly?: boolean;
  /** What else there is to say of it. Never a secret, nor anything a secret is made of. */
  readonly detail?: EventDetail;
  /** Who did it, where that is not whoever the fiber's request came from. */
  readonly actor?: EventActor;
  /** Where the request came from, where the fiber is not told. */
  readonly address?: string | null;
}

/** Which events are asked for; all the caller reads, where nothing is said. */
export interface Asked {
  readonly kind?: EventKind | undefined;
  /** An account's id, or a part of what the actor was called. */
  readonly actor?: string | undefined;
  readonly resourceKind?: EventResource["kind"] | undefined;
  readonly resourceId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly since?: Date | undefined;
  readonly until?: Date | undefined;
  /** What the page before said the next is asked for with. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface Page {
  readonly events: ReadonlyArray<Event>;
  /** The cursor of the events before these; none where these are the oldest. */
  readonly next: string | null;
}

/**
 * The event log: what was done by whom, written once and never changed, and kept for a
 * while. What does something records it here, and is not held up by it.
 */
export interface EventsShape {
  /**
   * Records what was done, by whoever the fiber's request came from unless it says who.
   * It never fails: what is not recorded is logged, and what was done stays done.
   */
  readonly record: (event: Happened) => Effect.Effect<void>;
  /**
   * Events, the newest first. An admin reads all; anyone else what their own account did
   * or had done to it, and what was done in the workspaces they are in, those for a
   * workspace's admins where they are one. A token held to
   * resources reads only what is about those.
   */
  readonly list: (caller: Caller, asked: Asked) => Effect.Effect<Page, Forbidden>;
  /** Forgets the events that are older than they are kept for. */
  readonly forget: () => Effect.Effect<void>;
}

export class Events extends Context.Service<Events, EventsShape>()(
  "@aperture-browser/control/Events",
) {}
