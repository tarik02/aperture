import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Executor from "./executor.ts";
import { directory } from "./process.ts";

type Node = Executor.ExecutorService;

export interface NodesService {
  /** The store the nodes share, as `APERTURE_SNAPSHOT_STORE` and `APERTURE_SESSION_STORE` take it. */
  readonly store: string;
  /** Starts one more node on the store, there until the suite ends. */
  readonly start: (env?: Record<string, string>) => Effect.Effect<Node, Executor.StartError>;
}

/** Nodes that share a store: a directory, which is to them what a bucket is. */
export class Nodes extends Context.Service<Nodes, NodesService>()("@aperture-browser/e2e/Nodes") {}

/** A store for a suite, and nodes on it as the checks ask for them; `options` says how each uses the store. */
export const layer = (options: (store: string) => Executor.ExecutorOptions) =>
  Layer.effect(
    Nodes,
    Effect.gen(function* () {
      // Before any node, so that it outlasts them all.
      const shared = yield* directory;
      const store = `file://${shared}`;
      const suite = yield* Effect.context<
        Scope.Scope | Effect.Services<ReturnType<typeof Executor.start>>
      >();
      const withStore = (env: Record<string, string>): Executor.ExecutorOptions => {
        const all = options(store);
        return { ...all, env: { ...all.env, ...env } };
      };
      return {
        store,
        start: (env = {}) => Executor.start(withStore(env)).pipe(Effect.provide(suite)),
      } satisfies NodesService;
    }),
  );

/** How many layers the node has on its own storage. */
export const layersOn = (node: Node) =>
  FileSystem.FileSystem.use((fs) => fs.readDirectory(`${node.data}/layers`)).pipe(
    Effect.map((layers) => layers.length),
    Effect.orElseSucceed(() => 0),
  );
