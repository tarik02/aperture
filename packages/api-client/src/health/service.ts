import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiRequestError } from "../errors.ts";
import type { Health } from "../schemas.ts";

/** The instance's unauthenticated health check. */
export class HealthApi extends Context.Service<
  HealthApi,
  {
    readonly getHealth: () => Effect.Effect<Health, ApiRequestError>;
  }
>()("@aperture-browser/api-client/HealthApi") {}
