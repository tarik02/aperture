import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { EventsPage, ResourceEvent } from "../schemas.ts";

export interface EventsListParams {
  limit?: number;
  cursor?: string;
  resourceType?: string;
  resourceId?: string;
}

export type EventsFilter = Omit<EventsListParams, "cursor">;

/** The tenant's resource event log. */
export class EventsApi extends Context.Service<
  EventsApi,
  {
    readonly listEvents: (
      credentials: ApiCredentials,
      params?: EventsListParams,
    ) => Effect.Effect<EventsPage, ApiRequestError>;
    /** Every matching event, newest first, fetching pages as the stream is pulled. */
    readonly streamEvents: (
      credentials: ApiCredentials,
      filter?: EventsFilter,
    ) => Stream.Stream<ResourceEvent, ApiRequestError>;
    readonly listAllEvents: (
      credentials: ApiCredentials,
      filter?: EventsFilter,
    ) => Effect.Effect<ReadonlyArray<ResourceEvent>, ApiRequestError>;
  }
>()("@aperture-browser/api-client/EventsApi") {}
