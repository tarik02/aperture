import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Playwright } from "effect-playwright";
import { errorMessage } from "./browser/error.js";
import { makeCdp, restoreError } from "./cdp.js";
import { StorageExportInput } from "./export-schema.js";
import { exportStorage } from "./export-storage.js";
import { PayloadSource } from "./payload-source.js";
import { restoreStorage } from "./restore-storage.js";
import { restoreTargets } from "./restore-targets.js";
import { Capsule, describeIssue } from "./schema.js";
import { UnsupportedStorageError } from "./storage-inventory.js";

// Go reads at most this much worker output.
const maxExportBytes = 64 * 1024 * 1024;

const usage =
  "usage: aperture-browser-restore validate <capsule> | restore <cdp-url> <capsule> | export <cdp-url> <selection>";

// Exit code 2 tells Go that the capsule itself is invalid; stderr then holds the reason.
// UnsupportedStorageError uses exit code 3 the same way for storage an export cannot represent.
class InvalidCapsule extends Data.TaggedError("InvalidCapsule")<{ readonly message: string }> {
  readonly [Runtime.errorExitCode] = 2;
}

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {
  readonly [Runtime.errorExitCode] = 64;
}

// Go logs this failure's bounded diagnostic locally and keeps the public API error generic.
class RestoreFailed extends Data.TaggedError("RestoreFailed")<{ readonly message: string }> {
  readonly [Runtime.errorExitCode] = 1;
}

// Strips URLs and file paths, which may carry restored browser data, from a failure.
// Wrappers such as PlaywrightError have no message of their own, so the causes follow.
function diagnosticMessage(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current !== undefined && parts.length < 8; ) {
    if (current instanceof Playwright.PlaywrightError) {
      parts.push(`PlaywrightError(${current.reason})`);
    } else {
      parts.push(errorMessage(current));
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts
    .join(" <- ")
    .replaceAll(/\b(?:https?|wss?|file):\/\/\S+|\b(?:blob|data):\S+/giu, "[url]")
    .replaceAll(/(^|\s)\/(?:[^\s/]+\/)+\S*/gu, "$1[path]")
    .replaceAll(/\s+/gu, " ")
    .slice(0, 2048);
}

const decodeCapsule = Schema.decodeUnknownResult(Capsule);

const readCapsule = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  let parsed: unknown;
  try {
    // Treat explicit nulls like omitted optional fields.
    parsed = JSON.parse(text, (_key, value: unknown) => (value === null ? undefined : value));
  } catch {
    return yield* new InvalidCapsule({ message: "request body is not valid JSON" });
  }

  const result = decodeCapsule(parsed);
  if (Result.isFailure(result)) {
    return yield* new InvalidCapsule({ message: describeIssue(result.failure.issue) });
  }
  return result.success;
});

const readExportSelection = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StorageExportInput))(text).pipe(
    Effect.mapError((error) => new InvalidCapsule({ message: describeIssue(error.issue) })),
  );
});

const restore = Effect.fnUntraced(function* (browser: Playwright.Browser, capsule: Capsule) {
  const context = browser.contexts()[0];
  if (!context) {
    return yield* restoreError("browser has no default context");
  }

  const browserCDP = makeCdp(yield* browser.use((raw) => raw.newBrowserCDPSession()));
  if (capsule.storageState) {
    yield* restoreStorage(context, browserCDP, capsule.storageState);
  }

  return yield* restoreTargets(context, browserCDP, capsule.initialTargets ?? []);
});

const main = Effect.fnUntraced(function* () {
  const stdio = yield* Stdio.Stdio;
  const [command, ...args] = yield* stdio.args;
  if (command === "validate" && args.length === 1) {
    yield* readCapsule(args[0]);
    return;
  }

  const [cdpURL, inputPath] = args;
  if (
    (command !== "restore" && command !== "export") ||
    args.length !== 2 ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpURL)
  ) {
    return yield* new UsageError({ message: usage });
  }

  const playwright = yield* Playwright.Playwright;
  if (command === "export") {
    const selection = yield* readExportSelection(inputPath);
    const browser = yield* playwright.connectCDPScoped(cdpURL, { timeout: 15_000 });
    const output = JSON.stringify(yield* exportStorage(browser, selection));
    if (new TextEncoder().encode(output).byteLength > maxExportBytes) {
      return yield* new UnsupportedStorageError({ message: "storage export exceeds 64 MiB" });
    }
    yield* Stream.make(output).pipe(Stream.run(stdio.stdout()));
    return;
  }

  const capsule = yield* readCapsule(inputPath);
  const browser = yield* playwright.connectCDPScoped(cdpURL, { timeout: 15_000 });
  const result = yield* restore(browser, capsule);
  yield* Stream.make(`${JSON.stringify(result)}\n`).pipe(Stream.run(stdio.stdout()));

  // Preload scripts added through this CDP connection disappear when it closes. Go
  // installs the remaining session storage scripts itself, then closes stdin.
  yield* Stream.runDrain(stdio.stdin);
}, Effect.scoped);

const program = main().pipe(
  Effect.catchCause(
    (
      cause,
    ): Effect.Effect<
      never,
      InvalidCapsule | UsageError | UnsupportedStorageError | RestoreFailed,
      Stdio.Stdio
    > => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }
      const error = Cause.squash(cause);
      const reported =
        error instanceof InvalidCapsule ||
        error instanceof UsageError ||
        error instanceof UnsupportedStorageError
          ? error
          : new RestoreFailed({ message: diagnosticMessage(error) });
      return Stdio.Stdio.use((stdio) =>
        Stream.make(`${reported.message}\n`).pipe(Stream.run(stdio.stderr())),
      ).pipe(Effect.ignore, Effect.andThen(Effect.fail(reported)));
    },
  ),
  Effect.provide(
    PayloadSource.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer, Playwright.layer),
      ),
    ),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
