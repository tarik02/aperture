import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { apiClientLayer } from "@aperture-browser/api-client";

const AppLayer = Layer.mergeAll(
  apiClientLayer,
  // Requests stay on this origin; there is no collector for trace headers.
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
).pipe(Layer.provide(FetchHttpClient.layer));

export type AppServices = Layer.Success<typeof AppLayer>;

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/** Builds the runtime the web app runs its effects on, including all API access. */
export const makeAppRuntime = (): AppRuntime => ManagedRuntime.make(AppLayer);
