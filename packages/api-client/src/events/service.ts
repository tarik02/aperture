import { Context, type Effect } from "effect";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { EventsPage } from "../schemas.ts";

export type EventsListParams = {
  limit?: number;
  cursor?: string;
  resourceType?: string;
  resourceId?: string;
};

/** The tenant's resource event log. */
export class EventsApi extends Context.Service<
  EventsApi,
  {
    readonly listEvents: (
      credentials: ApiCredentials,
      params?: EventsListParams,
    ) => Effect.Effect<EventsPage, ApiRequestError>;
  }
>()("@aperture/api-client/EventsApi") {}
