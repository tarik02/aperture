import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { NodeStoreUnusable, ProfileNotCopied } from "../errors.ts";
import { type NodeLayer, type NodeSession, type NodeSnapshot, NodeStore } from "./store.ts";

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

/**
 * A session's record as `aperture-store` reads it, of one that was never run here: it is
 * held to no limits and offers what its node does, was suspended on request, and is no
 * state nodes share.
 */
const SessionRecord = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    created_at_ms: Schema.Number,
    snapshot_id: Schema.NullOr(Schema.String),
    base_layer: Schema.NullOr(Schema.String),
    freezing: Schema.Null,
    proxy: Schema.Unknown,
    limits: Schema.Null,
    options: Schema.Null,
    asleep: Schema.Literal(false),
    revision: Schema.Null,
  }),
);

/** What a session has beside its profile and files, which begin empty. */
const SESSION_DIRECTORIES = ["work", "cache", "logs", "state"];

/** What v1 kept among a session's files for itself: a lock, and recordings it had not ended. */
const NOT_FILES = /^(?:\.lock|\.recording-.*)$/u;

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
 * <root>/sessions/<id>/{session.json,upper/,work/,cache/,files/,logs/,state/}
 * ```
 *
 * The executor may be running meanwhile. A snapshot's record is written first: a layer
 * something names is kept, and one that has no record of its own yet is no layer, so a
 * session asked for too early is refused rather than built on half a profile. A session
 * is put together aside and renamed into place, as the executor makes one, so that it is
 * there with its record or not at all.
 */
export const makeNodeStore = Effect.fn("NodeStore.make")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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

  const check = Effect.fn("NodeStore.check")(function* () {
    for (const sub of ["layers", "snapshots", "sessions"]) {
      const there = yield* fs.exists(path.join(dir, sub)).pipe(Effect.orElseSucceed(() => false));
      if (!there) {
        return yield* unusable(`it has no ${sub}: an executor's APERTURE_DATA_DIR has`);
      }
    }
  });

  /** Removes what Chromium left in a profile about the process that had it open. */
  const unlock = Effect.fn(function* (profile: string) {
    for (const left of PROCESS_FILES) {
      yield* fs.remove(path.join(profile, left), { force: true });
    }
  });

  const layerOf = Effect.fn(function* (given: NodeLayer) {
    const layer = path.join(dir, "layers", given.id);
    if (yield* fs.exists(path.join(layer, "layer.json"))) {
      return;
    }
    yield* fs.remove(layer, { recursive: true, force: true });
    yield* fs.makeDirectory(layer, { recursive: true });
    const files = path.join(layer, "fs");
    yield* fs.copy(given.profile, files, { preserveTimestamps: true });
    yield* fs.chmod(files, OWNER_ALL | OTHERS_READ);
    yield* openUp(files);
    yield* unlock(files);
    yield* write(
      path.join(layer, "layer.json"),
      yield* Schema.encodeEffect(LayerRecord)({ parent: null }).pipe(Effect.orDie),
    );
  });

  const putLayer = Effect.fn("NodeStore.putLayer")(function* (layer: NodeLayer) {
    yield* check();
    yield* layerOf(layer).pipe(
      Effect.mapError((error) => new ProfileNotCopied({ of: layer.name, reason: error.message })),
    );
  });

  const putSnapshot = Effect.fn("NodeStore.putSnapshot")(function* (snapshot: NodeSnapshot) {
    yield* check();
    // The layer has the snapshot's id: one is made of the other, and of nothing else.
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
      yield* layerOf(snapshot);
    }).pipe(
      Effect.mapError(
        (error) => new ProfileNotCopied({ of: snapshot.name, reason: error.message }),
      ),
    );
  });

  /**
   * Copies what overlayfs keeps above a layer as it is: the devices that say a file of the
   * layer is gone and the attributes that say a directory hides the layer's, which no copy
   * of files and their contents alone would bring.
   */
  const copyUpper = Effect.fn(function* (from: string, to: string) {
    const code = yield* spawner
      .exitCode(
        ChildProcess.make("cp", ["--archive", "--no-preserve=ownership", from, to], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.orElseSucceed(() => -1));
    if (code !== 0) {
      return yield* Effect.fail({ message: `cp --archive ${from} did not end well (${code})` });
    }
  });

  const putSession = Effect.fn("NodeStore.putSession")(function* (session: NodeSession) {
    yield* check();
    const sessions = path.join(dir, "sessions");
    const placed = path.join(sessions, session.id);
    yield* Effect.gen(function* () {
      if (yield* fs.exists(path.join(placed, "session.json"))) {
        return;
      }
      // The executor takes a directory without a record for what a crash left, and removes
      // it when it starts; one whose name is no id is no session to it meanwhile.
      const staged = path.join(sessions, `.${session.id}`);
      yield* fs.remove(staged, { recursive: true, force: true });
      yield* fs.remove(placed, { recursive: true, force: true });
      for (const sub of SESSION_DIRECTORIES) {
        yield* fs.makeDirectory(path.join(staged, sub), { recursive: true });
      }
      const upper = path.join(staged, "upper");
      yield* copyUpper(session.upper, upper);
      yield* fs.chmod(upper, OWNER_ALL | OTHERS_READ);
      yield* openUp(upper);
      yield* unlock(upper);
      const files = path.join(staged, "files");
      if (session.files === null) {
        yield* fs.makeDirectory(files);
      } else {
        yield* fs.copy(session.files, files, { preserveTimestamps: true });
        yield* fs.chmod(files, OWNER_ALL | OTHERS_READ);
        yield* openUp(files);
        for (const below of ["", "recordings"]) {
          const entries = yield* fs
            .readDirectory(path.join(files, below))
            .pipe(Effect.orElseSucceed(() => []));
          for (const name of entries.filter((entry) => NOT_FILES.test(entry))) {
            yield* fs.remove(path.join(files, below, name), { recursive: true, force: true });
          }
        }
      }
      yield* write(
        path.join(staged, "session.json"),
        yield* Schema.encodeEffect(SessionRecord)({
          id: session.id,
          created_at_ms: session.createdAt.getTime(),
          snapshot_id: session.snapshotId,
          base_layer: session.layer,
          freezing: null,
          proxy: session.proxy,
          limits: null,
          options: null,
          asleep: false,
          revision: null,
        }).pipe(Effect.orDie),
      );
      yield* fs.rename(staged, placed);
    }).pipe(
      Effect.mapError((error) => new ProfileNotCopied({ of: session.name, reason: error.message })),
    );
  });

  return NodeStore.of({ check, putLayer, putSnapshot, putSession });
});

export const layer = (root: string) => Layer.effect(NodeStore, makeNodeStore(root));

const none = (of: { readonly name: string }) =>
  Effect.fail(new ProfileNotCopied({ of: of.name, reason: "no node was named" }));

/** For a move that has nothing to put on a node: none was named. */
export const layerNone = Layer.succeed(
  NodeStore,
  NodeStore.of({
    check: () => Effect.void,
    putLayer: none,
    putSnapshot: none,
    putSession: none,
  }),
);
