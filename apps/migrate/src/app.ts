import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Control from "./control.ts";
import * as MigratorLayer from "./migrator/layer.ts";
import * as NodeStoreLocal from "./node/store-local.ts";
import type { Choices } from "./plan.ts";
import * as TokenSecretsFile from "./secrets/file.ts";
import * as V1SourceSqlite from "./v1/source-sqlite.ts";

/** Everything a move is told. */
export interface Asked extends Choices {
  readonly v1Database: string;
  /** v1's cold root; the directory its database is in, without. */
  readonly v1ColdRoot: Option.Option<string>;
  /** v1's store root; its cold root, without. */
  readonly v1StoreRoot: Option.Option<string>;
  /** The node that takes v1's snapshots and sessions, by the name it registered with. */
  readonly node: Option.Option<string>;
  /** That node's `APERTURE_DATA_DIR`, on this machine. */
  readonly nodeStore: Option.Option<string>;
  readonly secretsFile: Option.Option<string>;
}

/**
 * The migrator between a v1 that is read and never written, and the v2 the control
 * plane's own settings name.
 */
export const layer = (asked: Asked) => {
  const coldRoot = Option.getOrElse(asked.v1ColdRoot, () =>
    asked.v1Database.replace(/\/[^/]*$/u, ""),
  );
  return MigratorLayer.layer({
    tokens: asked.tokens,
    sessions: asked.sessions,
    // A node is named with where its store is, or not at all.
    node: Option.isSome(asked.nodeStore) ? Option.getOrUndefined(asked.node) : undefined,
    secretsFile: Option.isSome(asked.secretsFile),
  }).pipe(
    Layer.provide(
      V1SourceSqlite.layer({
        database: asked.v1Database,
        coldRoot,
        storeRoot: Option.getOrElse(asked.v1StoreRoot, () => coldRoot),
      }),
    ),
    Layer.provide(
      Option.match(asked.nodeStore, {
        onNone: () => NodeStoreLocal.layerNone,
        onSome: NodeStoreLocal.layer,
      }),
    ),
    Layer.provide(
      Option.match(asked.secretsFile, {
        onNone: () => TokenSecretsFile.layerNone,
        onSome: TokenSecretsFile.layer,
      }),
    ),
    Layer.provide(Control.layer),
  );
};
