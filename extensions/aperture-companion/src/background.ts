import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  captureBrowserState,
  capturePermissionOrigins,
  requestCapturePermissions,
} from "./capture.ts";
import { chromeCall, CompanionError, getTab, hasOrigins, isWebURL } from "./chrome.ts";
import {
  CompanionCommand,
  ConnectResult,
  TeleportTabsResult,
  type TeleportTabsCommand,
} from "./commands.ts";
import {
  connect,
  connectionOriginPattern,
  createSession,
  openSnapshots,
  openWorkbench,
  promoteSession,
  requireActiveConnection,
} from "./connection.ts";
import { commandError, failureMessage } from "./errors.ts";
import {
  listPendingCommands,
  pendingCommand,
  pendingCommandLifetime,
  type PendingCommand,
} from "./pending-command.ts";
import { popupState } from "./popup-state.ts";
import type { TeleportDestination } from "./schema.ts";
import { teleportOperation, type TeleportStage } from "./teleport-operation.ts";

const menuId = "teleport-page-to-aperture";
const defaultTags = { source: "aperture-companion", action: "teleport" };

const decodeCommand = Schema.decodeUnknownOption(CompanionCommand);

// Popup callbacks waiting for their command's result. They are gone once the popup
// closes or the worker restarts; the stored teleport operation still reports the outcome.
const responders = new Map<string, (response: unknown) => void>();
const runningCommandIds = new Set<string>();

// Results are encoded, since messages lose the prototype of error classes.
const respond = <A, I>(id: string, schema: Schema.Codec<A, I>, response: A) =>
  Schema.encodeEffect(schema)(response).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.sync(() => {
        const responder = responders.get(id);
        responders.delete(id);
        responder?.(encoded);
      }),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runFork(
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Aperture Companion failed", Cause.pretty(cause)),
      ),
    ),
  );

const showFailureBadge = Effect.gen(function* () {
  yield* chromeCall("action.setBadgeBackgroundColor", () =>
    chrome.action.setBadgeBackgroundColor({ color: "#b42318" }),
  );
  yield* chromeCall("action.setBadgeText", () => chrome.action.setBadgeText({ text: "!" }));
  yield* Effect.sleep("5 seconds").pipe(
    Effect.andThen(
      chromeCall("action.setBadgeText", () => chrome.action.setBadgeText({ text: "" })),
    ),
    Effect.forkDetach,
  );
}).pipe(Effect.ignore);

/**
 * Runs a teleport and records its progress, which the popup shows even after it reopens.
 * Returns the capture warnings.
 */
const runTeleport = Effect.fnUntraced(function* (
  id: string,
  destination: TeleportDestination,
  startedAt: number,
  teleport: (
    setStage: (stage: TeleportStage) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<string[], unknown>,
) {
  const setStage = (stage: TeleportStage) =>
    teleportOperation.set({ id, destination, startedAt, status: "running", stage });
  return yield* setStage("capturing").pipe(
    Effect.andThen(teleport(setStage)),
    Effect.tap((warnings) =>
      Effect.andThen(
        Effect.ignore(popupState.remove),
        teleportOperation.set({
          id,
          destination,
          startedAt,
          status: "succeeded",
          completedAt: Date.now(),
          warnings,
        }),
      ),
    ),
    Effect.tapCause((cause) =>
      Effect.ignore(
        teleportOperation.set({
          id,
          destination,
          startedAt,
          status: "failed",
          completedAt: Date.now(),
          error: failureMessage(cause),
        }),
      ),
    ),
  );
});

/** Teleports one page into a new session, from the page's context menu. */
const teleportPage = (tab: chrome.tabs.Tab) =>
  runTeleport(crypto.randomUUID(), "session", Date.now(), (setStage) =>
    Effect.gen(function* () {
      const connection = yield* requireActiveConnection;
      if (tab.id === undefined || !isWebURL(tab.url)) {
        return yield* new CompanionError({ message: "Only HTTP and HTTPS tabs can be teleported" });
      }
      const captured = yield* captureBrowserState([tab], tab.id);
      yield* setStage("creating-session");
      const sessionId = yield* createSession(connection, {
        targets: captured.targets,
        storageState: captured.storageState,
        label: tab.title,
        tags: defaultTags,
        waitForReady: false,
      });
      yield* setStage("opening");
      yield* openWorkbench(connection, sessionId);
      return captured.warnings;
    }),
  );

/** Teleports the tabs the popup selected into a new session or snapshot. */
const teleportTabs = (command: TeleportTabsCommand, startedAt: number) =>
  runTeleport(command.id, command.destination, startedAt, (setStage) =>
    Effect.gen(function* () {
      const connection = yield* requireActiveConnection;
      const tabs = yield* Effect.forEach(command.tabIds, getTab);
      if (!tabs.some(({ id }) => id === command.activeTabId)) {
        return yield* new CompanionError({ message: "The active tab is unavailable" });
      }
      const captured = yield* captureBrowserState(tabs, command.activeTabId);
      const snapshot = command.destination === "snapshot";
      yield* setStage("creating-session");
      const sessionId = yield* createSession(connection, {
        targets: captured.targets,
        storageState: captured.storageState,
        baseSnapshotName: command.baseSnapshotName,
        label: command.label,
        tags: command.tags,
        // A snapshot is taken from a session that finished restoring.
        waitForReady: snapshot,
      });
      if (snapshot) {
        yield* setStage("creating-snapshot");
        yield* promoteSession(connection, sessionId, {
          name: command.snapshotName ?? "",
          description: command.description ?? "",
          tags: command.tags,
        });
        yield* setStage("opening");
        yield* openSnapshots(connection);
      } else {
        yield* setStage("opening");
        yield* openWorkbench(connection, sessionId);
      }
      return captured.warnings;
    }),
  );

const requiredOrigins = (command: CompanionCommand) =>
  command.type === "connect"
    ? connectionOriginPattern(command.origin).pipe(Effect.map((pattern) => [pattern]))
    : Effect.forEach(command.tabIds, getTab).pipe(Effect.flatMap(capturePermissionOrigins));

const failCommand = Effect.fnUntraced(function* (
  command: CompanionCommand,
  startedAt: number,
  cause: Cause.Cause<unknown>,
) {
  const error = commandError(cause);
  if (command.type === "teleport-tabs") {
    yield* Effect.ignore(
      teleportOperation.set({
        id: command.id,
        destination: command.destination,
        startedAt,
        status: "failed",
        completedAt: Date.now(),
        error: error.message,
      }),
    );
    yield* showFailureBadge;
    yield* respond(command.id, TeleportTabsResult, { ok: false, error });
  } else {
    yield* respond(command.id, ConnectResult, { ok: false, error });
  }
});

const runPendingCommand = Effect.fnUntraced(function* ({ command, createdAt }: PendingCommand) {
  if (command.type === "connect") {
    const connection = yield* connect(command.origin, command.token);
    yield* respond(command.id, ConnectResult, { ok: true, connectionId: connection.id });
  } else {
    const warnings = yield* teleportTabs(command, createdAt);
    yield* respond(command.id, TeleportTabsResult, { ok: true, warnings });
  }
});

/** Runs a pending command once its origins are granted, or fails it once it expired. */
const resume = Effect.fnUntraced(function* (id: string) {
  const stored = pendingCommand(id);
  const pending = Option.getOrNull(yield* stored.get);
  if (pending === null) return;
  const expired = Date.now() - pending.createdAt >= Duration.toMillis(pendingCommandLifetime);
  if (!expired && !(yield* hasOrigins(pending.origins))) return;

  yield* (
    expired
      ? Effect.fail(new CompanionError({ message: "Access was not granted" }))
      : runPendingCommand(pending)
  ).pipe(
    Effect.catchCause((cause) => failCommand(pending.command, pending.createdAt, cause)),
    Effect.ensuring(Effect.ignore(stored.remove)),
  );
});

// Several events resume a command; it runs once at a time.
const resumePendingCommand = (id: string) =>
  Effect.suspend(() => {
    if (runningCommandIds.has(id)) return Effect.void;
    runningCommandIds.add(id);
    return resume(id).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => runningCommandIds.delete(id))),
    );
  });

const resumePendingCommands = listPendingCommands.pipe(
  Effect.flatMap((pending) =>
    Effect.forEach(pending, ({ command }) => resumePendingCommand(command.id), {
      concurrency: "unbounded",
      discard: true,
    }),
  ),
);

/**
 * Stores a command until the origins it needs are granted, replacing an older command of
 * the same type. It runs right away when they already are, and fails once it expires.
 */
const queueCommand = Effect.fnUntraced(function* (command: CompanionCommand) {
  const createdAt = Date.now();
  yield* Effect.gen(function* () {
    const existing = yield* listPendingCommands;
    yield* Effect.forEach(
      existing.filter((pending) => pending.command.type === command.type),
      (pending) => pendingCommand(pending.command.id).remove,
      { discard: true },
    );

    const origins = yield* requiredOrigins(command);
    if (command.type === "teleport-tabs") {
      yield* teleportOperation.set({
        id: command.id,
        destination: command.destination,
        startedAt: createdAt,
        status: "running",
        stage: "requesting-access",
      });
    }
    yield* pendingCommand(command.id).set({ command, origins, createdAt });
    yield* resumePendingCommand(command.id);
    yield* resumePendingCommand(command.id).pipe(
      Effect.delay(pendingCommandLifetime),
      Effect.forkDetach,
    );
  }).pipe(Effect.catchCause((cause) => failCommand(command, createdAt, cause)));
});

// Chromium only delivers the events that woke the worker to listeners registered while
// the script first runs, so these stay synchronous and top-level.
chrome.runtime.onInstalled.addListener(() => {
  run(
    Effect.gen(function* () {
      yield* chromeCall("contextMenus.removeAll", () => chrome.contextMenus.removeAll());
      yield* chromeCall("contextMenus.create", async () =>
        chrome.contextMenus.create({
          id: menuId,
          title: "Teleport page to Aperture",
          contexts: ["page"],
          documentUrlPatterns: ["http://*/*", "https://*/*"],
        }),
      );
    }),
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== menuId || tab?.url === undefined) return;
  // The access request has to start while the click still counts as a user gesture, and
  // the fiber runs synchronously up to it.
  run(
    requestCapturePermissions([tab]).pipe(
      Effect.andThen(teleportPage(tab)),
      Effect.tapCause(() => showFailureBadge),
    ),
  );
});

chrome.permissions.onAdded.addListener(() => {
  run(resumePendingCommands);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const command = decodeCommand(message);
  if (Option.isNone(command)) return false;
  responders.set(command.value.id, sendResponse);
  run(queueCommand(command.value));
  // Keeps sendResponse valid until the command finishes.
  return true;
});

run(resumePendingCommands);
