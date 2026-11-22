import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The record of what was moved: what v1 called each thing, and what it is in v2. It is
 * what makes moving again change nothing, and what a move that was cut short goes on from.
 */
export interface MovedStoreShape {
  /** Makes the record's own table where it is not there yet. */
  readonly prepare: () => Effect.Effect<void>;
  /** Everything moved so far, as `kind:v1 id` to the v2 id; nothing where nothing ever was. */
  readonly all: () => Effect.Effect<ReadonlyMap<string, string>>;
  readonly record: (moved: {
    readonly key: string;
    readonly v2Id: string;
    readonly at: Date;
  }) => Effect.Effect<void>;
}

export class MovedStore extends Context.Service<MovedStore, MovedStoreShape>()(
  "@aperture-browser/migrate/MovedStore",
) {}
