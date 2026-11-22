import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { NodeStoreUnusable, ProfileNotCopied } from "../errors.ts";
import { type NodeSnapshot, NodeSnapshots } from "./snapshots.ts";

/** A snapshot's record as `aperture-store` reads it. */
const SnapshotRecord = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
    session_id: Schema.String,
    layer: Schema.NullOr(Schema.String),
    created_at_ms: Schema.Number,
  }),
);

/** A layer's record: a whole profile stands on no other layer. */
const LayerRecord = Schema.fromJsonString(Schema.Struct({ parent: Schema.Null }));

const OWNER_ALL = 0o700;
const OWNER_READS_AND_WRITES = 0o600;
const OTHERS_READ = 0o055;

/**
 * What Chromium leaves in a profile about the process that had it open. A profile that
 * carries them to another process looks locked to it.
 */
const PROCESS_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"];

/**
 * The store of a node on this machine, written as its executor writes it:
 *
 * ```text
 * <root>/snapshots/<id>.json
 * <root>/layers/<id>/{layer.json,fs/}
 * ```
 *
 * The executor may be running meanwhile. The snapshot's record is written first: a layer
 * something names is kept, and one that has no record of its own yet is no layer, so a
 * session asked for too early is refused rather than built on half a profile.
 */
export const makeNodeSnapshots = Effect.fn("NodeSnapshots.make")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(root);
  const unusable = (reason: string) => new NodeStoreUnusable({ dir, reason });

  /** Through a rename, so the executor finds the record whole or not at all. */
  const write = Effect.fn(function* (file: string, record: string) {
    const staged = `${file}.tmp`;
    yield* fs.writeFileString(staged, record);
    yield* fs.rename(staged, file);
  });

  /**
   * Gives the owner every directory and file below one. The browser writes above the
   * profile as whoever owns it, and what it copies up from a layer keeps the layer's mode:
   * a profile that was kept read-only would be one the browser cannot go on with.
   */
  const openUp: (below: string) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fn(
    function* (below: string) {
      for (const name of yield* fs.readDirectory(below)) {
        const entry = path.join(below, name);
        // A link is left as it is: its mode is not its own, and what it names is not ours.
        if (Option.isSome(yield* fs.readLink(entry).pipe(Effect.option))) {
          continue;
        }
        const { mode, type } = yield* fs.stat(entry);
        const wanted = mode | (type === "Directory" ? OWNER_ALL : OWNER_READS_AND_WRITES);
        if (wanted !== mode) {
          yield* fs.chmod(entry, wanted);
        }
        if (type === "Directory") {
          yield* openUp(entry);
        }
      }
    },
  );

  const check = Effect.fn("NodeSnapshots.check")(function* () {
    for (const sub of ["layers", "snapshots", "sessions"]) {
      const there = yield* fs.exists(path.join(dir, sub)).pipe(Effect.orElseSucceed(() => false));
      if (!there) {
        return yield* unusable(`it has no ${sub}: an executor's APERTURE_DATA_DIR has`);
      }
    }
  });

  const put = Effect.fn("NodeSnapshots.put")(function* (snapshot: NodeSnapshot) {
    yield* check();
    const failed = (error: { readonly message: string }) =>
      new ProfileNotCopied({ snapshot: snapshot.name, reason: error.message });
    // The layer has the snapshot's id: one is made of the other, and of nothing else.
    const layer = path.join(dir, "layers", snapshot.id);
    const record = path.join(dir, "snapshots", `${snapshot.id}.json`);
    yield* Effect.gen(function* () {
      if (!(yield* fs.exists(record))) {
        yield* write(
          record,
          yield* Schema.encodeEffect(SnapshotRecord)({
            id: snapshot.id,
            name: snapshot.name,
            session_id: snapshot.sessionId,
            layer: snapshot.id,
            created_at_ms: snapshot.createdAt.getTime(),
          }).pipe(Effect.orDie),
        );
      }
      if (yield* fs.exists(path.join(layer, "layer.json"))) {
        return;
      }
      yield* fs.remove(layer, { recursive: true, force: true });
      yield* fs.makeDirectory(layer, { recursive: true });
      const files = path.join(layer, "fs");
      yield* fs.copy(snapshot.profile, files, { preserveTimestamps: true });
      yield* fs.chmod(files, OWNER_ALL | OTHERS_READ);
      yield* openUp(files);
      for (const left of PROCESS_FILES) {
        yield* fs.remove(path.join(layer, "fs", left), { force: true });
      }
      yield* write(
        path.join(layer, "layer.json"),
        yield* Schema.encodeEffect(LayerRecord)({ parent: null }).pipe(Effect.orDie),
      );
    }).pipe(Effect.mapError(failed));
  });

  return NodeSnapshots.of({ check, put });
});

export const layer = (root: string) => Layer.effect(NodeSnapshots, makeNodeSnapshots(root));

/** For a move that has no snapshots to put anywhere: no node was named. */
export const layerNone = Layer.succeed(
  NodeSnapshots,
  NodeSnapshots.of({
    check: () => Effect.void,
    put: (snapshot) =>
      Effect.fail(new ProfileNotCopied({ snapshot: snapshot.name, reason: "no node was named" })),
  }),
);
