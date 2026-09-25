import * as Context from "effect/Context";
import type * as Api from "@aperture-browser/api-schema";
import type { PageCursor, PaginatedList } from "../pagination.ts";
import type { AuditEvent, ResourceEvent } from "../schemas.ts";

export interface EventsFilter {
  limit?: number;
  resourceType?: string;
  resourceId?: string;
}

export type EventsListParams = EventsFilter & PageCursor;

type EventsList = PaginatedList<EventsFilter, ResourceEvent>;

export interface AuditEventsFilter {
  limit?: number;
  tenantId?: string;
  actorType?: Api.PrincipalType;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
}

export type AuditEventsListParams = AuditEventsFilter & PageCursor;

type AuditEventsList = PaginatedList<AuditEventsFilter, AuditEvent>;

/** The tenant's resource event log, and the deployment-wide audit log. */
export class EventsApi extends Context.Service<
  EventsApi,
  {
    readonly listEvents: EventsList["list"];
    readonly streamEvents: EventsList["stream"];
    readonly listAllEvents: EventsList["listAll"];
    readonly listAuditEvents: AuditEventsList["list"];
    readonly streamAuditEvents: AuditEventsList["stream"];
    readonly listAllAuditEvents: AuditEventsList["listAll"];
  }
>()("@aperture-browser/api-client/EventsApi") {}
