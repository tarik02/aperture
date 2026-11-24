import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  NodeStoreUnusable,
  NotMappable,
  ProfileNotCopied,
  SecretsFileUnusable,
  StepFailed,
  V1DatabaseUnusable,
  V1SchemaUnexpected,
} from "../errors.ts";
import type { Choices, Plan } from "../plan.ts";

/** What a move is told beside where v1 and v2 are. */
export interface Options extends Choices {
  /** The node that takes v1's snapshots and sessions, by the name it registered with. */
  readonly node: string | undefined;
  /** Whether a file was named for the secrets of the tokens that are made anew. */
  readonly secretsFile: boolean;
}

export type ReadError = V1DatabaseUnusable | V1SchemaUnexpected | NodeStoreUnusable;

/** Moves what a v1 installation kept into v2. */
export interface MigratorShape {
  /** What moving would come to as v1 and v2 are now. It writes nothing. */
  readonly plan: () => Effect.Effect<Plan, ReadError>;
  /**
   * Moves what the plan says, a step at a time, each whole or not at all. What is moved
   * has the id it had in v1, so a move that was cut short goes on from where it stopped,
   * and one that has nothing left to do does nothing. With anything in the way, it moves
   * nothing.
   */
  readonly apply: () => Effect.Effect<
    Plan,
    ReadError | NotMappable | StepFailed | ProfileNotCopied | SecretsFileUnusable
  >;
}

export class Migrator extends Context.Service<Migrator, MigratorShape>()(
  "@aperture-browser/migrate/Migrator",
) {}
