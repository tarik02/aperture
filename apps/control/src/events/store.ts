import type {
  EventActor,
  EventDetail,
  EventKind,
  EventResource,
  TokenResources,
} from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Event } from "./schemas.ts";

export interface NewEvent {
  readonly id: string;
  readonly at: Date;
  readonly kind: EventKind;
  readonly actor: EventActor;
  readonly resource: EventResource | null;
  readonly ownerId: string | null;
  readonly workspaceId: string | null;
  readonly address: string | null;
  readonly detail: EventDetail;
}

/** Which events are looked for. */
export interface Sought {
  /**
   * Whose events they are: what the account did or had done to it, and what was done in
   * the workspaces. Everyone's, without.
   */
  readonly of: {
    readonly accountId: string | null;
    readonly workspaces: ReadonlyArray<string>;
  } | null;
  /** The resources they are about, for a token that is held to some; any, without. */
  readonly held: TokenResources | null;
  readonly kind: EventKind | undefined;
  readonly actor: string | undefined;
  readonly resourceKind: EventResource["kind"] | undefined;
  readonly resourceId: string | undefined;
  readonly workspaceId: string | undefined;
  readonly since: Date | undefined;
  readonly until: Date | undefined;
  /** The event they all come before, in the order they are told in. */
  readonly before: { readonly at: Date; readonly id: string } | undefined;
  readonly limit: number;
}

/** Where events are kept. Nothing changes one that is kept. */
export interface EventsStoreShape {
  readonly insert: (event: NewEvent) => Effect.Effect<void>;
  /** The newest first, and by id among those of one moment. */
  readonly list: (sought: Sought) => Effect.Effect<ReadonlyArray<Event>>;
  readonly deleteBefore: (before: Date) => Effect.Effect<void>;
}

export class EventsStore extends Context.Service<EventsStore, EventsStoreShape>()(
  "@aperture-browser/control/EventsStore",
) {}
