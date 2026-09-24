import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { apiClientLayer } from "@aperture/api-client";

const AppLayer = Layer.mergeAll(
  apiClientLayer,
  // Requests stay on this origin; there is no collector for trace headers.
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
).pipe(Layer.provide(FetchHttpClient.layer));

export type AppServices = Layer.Success<typeof AppLayer>;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/** Builds the runtime the web app runs its effects on, including all API access. */
export const makeAppRuntime = (): AppRuntime => ManagedRuntime.make(AppLayer);
