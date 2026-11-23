import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { failuresDirectory } from "./failures.ts";

/** Before any check: what was kept of the checks that failed the last time is gone. */
export default () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(yield* failuresDirectory, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer), Effect.ignore),
  );
