import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { apiClientLayer, baseUrlLayer, type ApiServices } from "@aperture-browser/api-client";

export type ApertureRuntime = ManagedRuntime.ManagedRuntime<ApiServices, never>;

export interface ApertureRuntimeOptions {
  readonly baseUrl?: string;
}

export const makeApertureRuntime = (options: ApertureRuntimeOptions = {}): ApertureRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(
      apiClientLayer.pipe(
        Layer.provide(options.baseUrl ? baseUrlLayer(options.baseUrl) : Layer.empty),
        Layer.provide(FetchHttpClient.layer),
      ),
      Layer.succeed(HttpClient.TracerPropagationEnabled, false),
    ),
  );
