import { EventActor, EventDetail, EventKind, EventResource } from "@aperture-browser/control-api";
import * as Schema from "effect/Schema";

/** An event as it is kept: something that was done, by whom and to what. */
export const Event = Schema.Struct({
  id: Schema.String,
  at: Schema.DateTimeUtcFromDate,
  kind: EventKind,
  actor: EventActor,
  /** What it was about, as that was called then; nothing where it is not known. */
  resource: Schema.NullOr(EventResource),
  /**
   * The account what it was about is of, or was done to: that account reads the event
   * though another did it.
   */
  ownerId: Schema.NullOr(Schema.String),
  /** The workspace what it was about is of, where it is of one. */
  workspaceId: Schema.NullOr(Schema.String),
  /** Where the request that did it came from, where one did and that is known. */
  address: Schema.NullOr(Schema.String),
  detail: EventDetail,
});
export type Event = typeof Event.Type;

/** The control plane by itself: what nobody asked for, as noting that a node fell silent. */
export const SYSTEM: EventActor = { kind: "system", id: null, name: null };

/** Someone who is not known, by what they said they were, where they said. */
export const anonymous = (name: string | null = null): EventActor => ({
  kind: "anonymous",
  id: null,
  name,
});
