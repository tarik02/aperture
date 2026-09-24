import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ApiClient, apiClientLayer, type ApiRequestError } from "@aperture/api-client";

const AppLayer = Layer.mergeAll(
  apiClientLayer,
  // Requests stay on this origin; there is no collector for trace headers.
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
).pipe(Layer.provide(FetchHttpClient.layer));

/** The one runtime the web app runs its effects on, including all API access. */
export const appRuntime = ManagedRuntime.make(AppLayer);

export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof appRuntime>;

/**
 * Runs one API operation for promise-based callers such as TanStack Query. Aborting the
 * signal interrupts the request.
 */
export function runApi<A>(
  operation: (api: ApiClient["Service"]) => Effect.Effect<A, ApiRequestError>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> {
  return appRuntime.runPromise(ApiClient.use(operation), options);
}

/**
 * Forks an effect on the app runtime and returns a function that interrupts it. The
 * interruption starts right away, so synchronous finalizers have run by the time the
 * function returns, which keeps React effect cleanups in order.
 */
export function forkEffect(effect: Effect.Effect<unknown, never, AppServices>): () => void {
  const fiber = appRuntime.runFork(effect);
  return () => fiber.interruptUnsafe();
}
