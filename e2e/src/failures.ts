import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Something kept of a check that failed: a file by its name. */
export interface Kept {
  readonly name: string;
  readonly content: string | Uint8Array;
}

/** What tells of a check that failed, asked when one did. Telling nothing is no failure of its own. */
export type Witness = Effect.Effect<ReadonlyArray<Kept>>;

/** How long all there is to tell gets to be told: a page that hangs is what failed the check. */
const TOLD_WITHIN = "20 seconds";

// Whatever a file's checks started that is still there: its programs and the pages it watches
// with. A file's checks run in a process of their own, one after another.
const witnesses = new Set<Witness>();

/** Has something tell of the checks that fail from now on, until the scope ends. */
export const witness = (tells: Witness) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      witnesses.add(tells);
    }),
    () =>
      Effect.sync(() => {
        witnesses.delete(tells);
      }),
  );

/**
 * Where what is kept of failed checks goes: `test-failures` at the root of the repository,
 * unless `APERTURE_E2E_FAILURES` names another directory. Below it each package's checks
 * have a directory, which is emptied as they start.
 */
export const failuresDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../test-failures", import.meta.url));
  const told = yield* Config.String("APERTURE_E2E_FAILURES").pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  return path.join(told === "" ? root : told, path.basename(path.resolve(".")));
});

const fileName = (said: string) =>
  said
    .replaceAll(/[^\p{L}\p{N}.]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 100);

/**
 * Keeps what there is to tell of a check that failed, for looking into it without running
 * it again: what its programs logged last and what its pages showed.
 */
export const keep = Effect.fn("Failures.keep")(function* (file: string, check: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const told = yield* Effect.forEach([...witnesses], (tells) =>
    tells.pipe(
      Effect.timeoutOrElse({ duration: TOLD_WITHIN, orElse: () => Effect.succeed([]) }),
      Effect.catchCause(() => Effect.succeed<ReadonlyArray<Kept>>([])),
    ),
  );
  const directory = path.join(
    yield* failuresDirectory,
    fileName(path.basename(file).replace(/\.test\.ts$/u, "")),
    fileName(check),
  );
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.forEach(
    told.flat(),
    (kept) =>
      typeof kept.content === "string"
        ? fs.writeFileString(path.join(directory, fileName(kept.name)), kept.content)
        : fs.writeFile(path.join(directory, fileName(kept.name)), kept.content),
    { discard: true },
  );
  return directory;
});
