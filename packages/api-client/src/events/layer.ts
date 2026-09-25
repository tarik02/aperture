import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture-browser/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { paginated } from "../pagination.ts";
import { compactQuery } from "../query.ts";
import type { AuditEvent, ResourceEvent } from "../schemas.ts";
import {
  EventsApi,
  type AuditEventsFilter,
  type AuditEventsListParams,
  type EventsFilter,
  type EventsListParams,
} from "./service.ts";

export const makeEventsApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const api = Api.make(httpClient);

  const listEvents = Effect.fn("EventsApi.listEvents")(function* (
    credentials: ApiCredentials,
    params: EventsListParams = {},
  ) {
    return yield* api
      .listEvents({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
        }),
      })
      .pipe(authorize(Authorization.tenantScoped(credentials)));
  });

  const listAuditEvents = Effect.fn("EventsApi.listAuditEvents")(function* (
    credentials: ApiCredentials,
    params: AuditEventsListParams = {},
  ) {
    return yield* api
      .listAuditEvents({
        params: compactQuery({
          limit: params.limit,
          cursor: params.cursor,
          tenantId: params.tenantId,
          actorType: params.actorType,
          actorId: params.actorId,
          action: params.action,
          resourceType: params.resourceType,
          resourceId: params.resourceId,
        }),
      })
      .pipe(authorize(Authorization.of(credentials)));
  });

  const events = paginated<EventsFilter, ResourceEvent>(listEvents);
  const auditEvents = paginated<AuditEventsFilter, AuditEvent>(listAuditEvents);

  return EventsApi.of({
    listEvents,
    streamEvents: events.stream,
    listAllEvents: events.listAll,
    listAuditEvents,
    streamAuditEvents: auditEvents.stream,
    listAllAuditEvents: auditEvents.listAll,
  });
});

export const eventsApiLayer = Layer.effect(EventsApi, makeEventsApi);
