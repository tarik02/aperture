import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Executor from "../src/executor.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

const node = Executor.layer({ env: { APERTURE_RECORDINGS_CHECK: "1s" } });

suite(node)("recordings kept longer than their session keeps them", (it) => {
  it.effect("stay while the session runs, and are removed once it is at rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const executor = yield* Executor.Executor;
      const { id } = yield* executor.client.sessions.create({
        limits: { keepRecordings: { seconds: 1n } },
      });
      const recordings = `${executor.data}/sessions/${id}/files/recordings`;
      const kept = `${recordings}/earlier.webm`;
      yield* fs.makeDirectory(recordings, { recursive: true });
      yield* fs.writeFileString(kept, "what was recorded");
      const anHourAgo = new Date(Date.now() - 3_600_000);
      yield* fs.utimes(kept, anHourAgo, anHourAgo);

      // Its runner tells and serves what it recorded from what it holds: nothing is
      // removed under it, however often the executor looks.
      yield* Effect.sleep("3 seconds");
      expect(yield* fs.exists(kept)).toBe(true);

      yield* executor.client.sessions.suspend(id);
      yield* until(
        "the recording being removed",
        Effect.map(fs.exists(kept), (there) => !there),
        "15 seconds",
      );
      yield* executor.client.sessions.delete(id);
    }),
  );
});
