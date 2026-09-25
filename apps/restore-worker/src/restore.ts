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
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Playwright } from "effect-playwright";
import { makeCdp, restoreError } from "./cdp.js";
import { PayloadSource } from "./payload-source.js";
import { restoreStorage } from "./restore-storage.js";
import { restoreTargets } from "./restore-targets.js";
import { Capsule } from "./schema.js";

const usage = "usage: aperture-browser-restore validate <capsule> | restore <cdp-url> <capsule>";

// Exit code 2 tells Go that the capsule itself is invalid; stderr then holds the reason.
class InvalidCapsule extends Data.TaggedError("InvalidCapsule")<{ readonly message: string }> {
  readonly [Runtime.errorExitCode] = 2;
}

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {
  readonly [Runtime.errorExitCode] = 64;
}

// Other failures stay generic because their details may contain restored browser data.
class RestoreFailed extends Data.TaggedError("RestoreFailed")<{ readonly message: string }> {
  readonly [Runtime.errorExitCode] = 1;
}

const decodeCapsule = Schema.decodeUnknownResult(Capsule);

// Formats the first validation issue as "initialTargets[0].url: message". Issues never
// include input values, which may be sensitive.
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function describeIssue(issue: SchemaIssue.Issue): string {
  const first = formatIssues(issue).issues[0];
  if (!first) return "invalid browser initialization";
  const path = (first.path ?? [])
    .map((segment) => (typeof segment === "object" ? segment.key : segment))
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`,
    )
    .join("");
  return path === "" ? first.message : `${path}: ${first.message}`;
}

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

const restore = Effect.fnUntraced(function* (browser: Playwright.Browser, capsule: Capsule) {
  const context = browser.contexts()[0];
  if (!context) return yield* restoreError("browser has no default context");

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

  const [cdpURL, capsulePath] = args;
  if (command !== "restore" || args.length !== 2 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpURL)) {
    return yield* new UsageError({ message: usage });
  }

  const capsule = yield* readCapsule(capsulePath);
  const playwright = yield* Playwright.Playwright;
  const browser = yield* playwright.connectCDPScoped(cdpURL, { timeout: 15_000 });
  const result = yield* restore(browser, capsule);
  yield* Stream.make(`${JSON.stringify(result)}\n`).pipe(Stream.run(stdio.stdout()));

  // Preload scripts added through this CDP connection disappear when it closes. Go
  // installs the remaining session storage scripts itself, then closes stdin.
  yield* Stream.runDrain(stdio.stdin);
}, Effect.scoped);

const program = main().pipe(
  Effect.catchCause(
    (cause): Effect.Effect<never, InvalidCapsule | UsageError | RestoreFailed, Stdio.Stdio> => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      const reported =
        error instanceof InvalidCapsule || error instanceof UsageError
          ? error
          : new RestoreFailed({ message: "browser restore failed" });
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
