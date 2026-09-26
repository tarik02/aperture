import {
  apiClientLayer,
  baseUrlLayer,
  type ApiCredentials,
  type ApiServices,
} from "@aperture-browser/api-client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Connection } from "./connection.ts";

const apiLayer = (origin: string) =>
  Layer.mergeAll(
    apiClientLayer.pipe(Layer.provide(baseUrlLayer(origin)), Layer.provide(FetchHttpClient.layer)),
    Layer.succeed(HttpClient.TracerPropagationEnabled, false),
  );

/** Provides the API services for the Aperture instance at `origin`. */
export const withApi =
  (origin: string) =>
  <A, E>(self: Effect.Effect<A, E, ApiServices>): Effect.Effect<A, E> =>
    Effect.provide(self, apiLayer(origin));

export const credentials = (connection: Connection): ApiCredentials => ({
  kind: "bearer",
  token: connection.token,
  authorityType: connection.authorityType,
  tenantId: connection.tenantId,
  selectedTenantId: connection.selectedTenantId,
});
