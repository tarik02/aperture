import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

/** What a step of a GitHub Actions job gives the steps and jobs after it. */
export interface ActionsShape {
  /**
   * Sets an output of the step, which may be of several lines. Run elsewhere than in a
   * job, it is written to the output instead.
   */
  readonly output: (
    name: string,
    value: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}

export class Actions extends Context.Service<Actions, ActionsShape>()(
  "@aperture-browser/tools/Actions",
) {}
