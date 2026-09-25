import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture-browser/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { paginate } from "../pagination.ts";
import { compactQuery } from "../query.ts";
import { EventsApi, type EventsFilter, type EventsListParams } from "./service.ts";

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

  const streamEvents = (credentials: ApiCredentials, filter: EventsFilter = {}) =>
    paginate(filter, (params) => listEvents(credentials, params));

  const listAllEvents = Effect.fn("EventsApi.listAllEvents")(function* (
    credentials: ApiCredentials,
    filter: EventsFilter = {},
  ) {
    return yield* Stream.runCollect(streamEvents(credentials, filter));
  });

  return EventsApi.of({ listEvents, streamEvents, listAllEvents });
});

export const eventsApiLayer = Layer.effect(EventsApi, makeEventsApi);
