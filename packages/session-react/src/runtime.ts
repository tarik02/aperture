import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { apiClientLayer, baseUrlLayer, type ApiServices } from "@aperture-browser/api-client";

export type ApertureRuntime = ManagedRuntime.ManagedRuntime<ApiServices, never>;

export interface ApertureRuntimeOptions {
  /** The Aperture instance to talk to; defaults to the page's own origin. */
  readonly baseUrl?: string;
}

/** Builds a runtime with every Aperture API service, sending requests with fetch. */
export const makeApertureRuntime = (options: ApertureRuntimeOptions = {}): ApertureRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(
      apiClientLayer.pipe(
        Layer.provide(options.baseUrl ? baseUrlLayer(options.baseUrl) : Layer.empty),
        Layer.provide(FetchHttpClient.layer),
      ),
      // There is no collector for trace headers.
      Layer.succeed(HttpClient.TracerPropagationEnabled, false),
    ),
  );
