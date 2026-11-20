import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

/** How long a program gets to end by itself once asked to. */
const ENDS_WITHIN_MS = 10_000;
/** How much of what a program said is kept to tell when a check fails. */
const SAID_MOST = 64 * 1024;

export interface Program {
  readonly child: ChildProcess;
  /** The end of what it wrote to its error output. */
  readonly said: () => string;
}

/** Runs a program for as long as the scope lasts. */
export const run = (
  program: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Effect.Effect<Program, never, import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(program, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let said = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        said = (said + chunk.toString()).slice(-SAID_MOST);
      });
      return { child, said: () => said };
    }),
    ({ child }) =>
      Effect.promise(
        () =>
          new Promise<void>((ended) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              ended();
              return;
            }
            const kill = setTimeout(() => child.kill("SIGKILL"), ENDS_WITHIN_MS);
            child.once("exit", () => {
              clearTimeout(kill);
              ended();
            });
            child.kill("SIGTERM");
          }),
      ),
  );

/** A port nothing listens on right now. */
export const freePort = Effect.promise(
  () =>
    new Promise<number>((found, failed) => {
      const probe = createServer();
      probe.once("error", failed);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() =>
          typeof address === "object" && address !== null
            ? found(address.port)
            : failed(new Error("no port was given")),
        );
      });
    }),
);

/** A directory of the scope's own, gone when it ends. Its path is short: sockets go below it. */
export const directory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "ap-e2e-"))),
  (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);
