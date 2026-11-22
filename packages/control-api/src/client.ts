import type * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Api } from "./api.ts";

export interface ClientOptions {
  /** Where the control plane is reached, as `https://aperture.example.com`. */
  readonly baseUrl: string;
  /** An account's API token, or the access token an app was given over OAuth. */
  readonly token: string;
}

/**
 * The control plane's API for whoever holds a token: a call for every route, each with
 * what it takes, what it answers and the errors it fails with. The requests are made by
 * the `HttpClient` it is given.
 */
export const make = (options: ClientOptions) =>
  HttpApiClient.make(Api, {
    baseUrl: options.baseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(options.token)),
  });

/** The API as `make` gives it. */
export type Client = Effect.Success<ReturnType<typeof make>>;
