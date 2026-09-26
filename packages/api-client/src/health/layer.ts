import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Api from "@aperture-browser/api-schema";
import { ApiAuthorization, Authorization } from "../authorization/service.ts";
import { HealthApi } from "./service.ts";

export const makeHealthApi = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const { authorize } = yield* ApiAuthorization;
  const api = Api.make(httpClient);

  const getHealth = Effect.fn("HealthApi.getHealth")(function* () {
    return yield* api.getHealth(undefined).pipe(authorize(Authorization.anonymous));
  });

  return HealthApi.of({ getHealth });
});

export const healthApiLayer = Layer.effect(HealthApi, makeHealthApi);
