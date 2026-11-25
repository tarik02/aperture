import type { SettingEntry, SettingKey, SettingLevel } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** What a level says of something: the deployment, with no scope, or one thing by its id. */
export interface Scope {
  readonly level: SettingLevel;
  /** Empty for the deployment. */
  readonly scopeId: string;
}

export interface Said extends Scope {
  readonly key: SettingKey;
  readonly entry: SettingEntry;
}

/** Where what the levels say of settings is kept. */
export interface PolicyStoreShape {
  /** Everything every level says: for going over many sessions at once. */
  readonly all: () => Effect.Effect<ReadonlyArray<Said>>;
  /** What these say. */
  readonly of: (scopes: ReadonlyArray<Scope>) => Effect.Effect<ReadonlyArray<Said>>;
  readonly put: (said: Said, at: Date) => Effect.Effect<void>;
  readonly remove: (scope: Scope, key: SettingKey) => Effect.Effect<void>;
  /**
   * Removes for good what was deleted before then: the records of sessions and their share
   * links, snapshots, API tokens, grants, who was in a workspace, workspaces nothing names
   * any more, and registration tokens no node names; and what was said of anything that
   * is gone. Accounts, nodes, apps and sign-in providers stay marked.
   */
  readonly purge: (before: Date) => Effect.Effect<void>;
}

export class PolicyStore extends Context.Service<PolicyStore, PolicyStoreShape>()(
  "@aperture-browser/control/PolicyStore",
) {}
