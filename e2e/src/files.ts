import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

type Known = Schema.ConstraintDecoder<unknown>;

/** A file the programs under test wrote as JSON, as the schema of what a check reads has it. */
export const json = Effect.fn("Files.json")(function* <S extends Known>(path: string, schema: S) {
  const fs = yield* FileSystem.FileSystem;
  const written = yield* fs.readFileString(path);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(written);
});

/** What is written as JSON to a line, one entry for each: a journal. */
export const entries = <S extends Known>(written: string, schema: S) => {
  const entry = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return Effect.forEach(written.trim().split("\n"), (line) => entry(line));
};

/** A file the programs under test wrote as JSON to a line, one entry for each. */
export const journal = Effect.fn("Files.journal")(function* <S extends Known>(
  path: string,
  schema: S,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* entries(yield* fs.readFileString(path), schema);
});
