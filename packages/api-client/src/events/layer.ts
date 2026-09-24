import { Effect, Layer } from "effect";
import * as Api from "@aperture/api-schema";
import { ApiAuthorization, Authorization, type ApiCredentials } from "../authorization/service.ts";
import { compactQuery } from "../query.ts";
import { EventsApi, type EventsListParams } from "./service.ts";

export const makeEventsApi = Effect.gen(function* () {
  const { httpClient, authorize } = yield* ApiAuthorization;
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

  return EventsApi.of({ listEvents });
});

export const eventsApiLayer = Layer.effect(EventsApi, makeEventsApi);
