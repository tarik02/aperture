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
import { chromeCall, CompanionError, getTab, hasOrigins, isWebURL, notGiven } from "./chrome.ts";
import {
  CancelResult,
  CommandFailed,
  CompanionMessage,
  type CompanionCommand,
  ConnectResult,
  DisconnectResult,
  ListSnapshotsResult,
  TeleportTabsResult,
  type TeleportTabsCommand,
} from "./commands.ts";
import {
  connect,
  connectWithOAuth,
  connectionOriginPattern,
  createSession,
  deleteSession,
  freshConnection,
  hasScope,
  listSnapshots,
  openSnapshots,
  openWorkbench,
  removeConnection,
  requireActiveConnection,
  requireSnapshotNameFree,
  suspendSession,
  takeSnapshot,
  waitForRestored,
  wasSnapshotTaken,
} from "./connection.ts";
import { connectionOperation } from "./connection-operation.ts";
import { commandError, failureMessage } from "./errors.ts";
import {
  listPendingCommands,
  pendingCommand,
  pendingCommandLifetime,
  saveTeleportCheckpoint,
  type PendingCommand,
  type TeleportCheckpoint,
} from "./pending-command.ts";
import { cancelPending } from "./pending-access.ts";
import { popupState } from "./popup-state.ts";
import { defaultTeleportTags, type TeleportDestination } from "./schema.ts";
import { teleportOperation, type TeleportStage } from "./teleport-operation.ts";

const menuId = "teleport-page-to-aperture";
const pendingCommandsAlarm = "aperture-companion-pending-commands";
const teleportLifetime = Duration.minutes(10);

const decodeCommand = Schema.decodeUnknownOption(CompanionMessage);

// Popup callbacks waiting for their command's result. They are gone once the popup
// closes or the worker restarts; the stored teleport operation still reports the outcome.
const responders = new Map<string, (response: unknown) => void>();
const runningCommandIds = new Set<string>();
const requestedCommandIds = new Set<string>();

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
  ) => Effect.Effect<readonly string[], unknown>,
) {
  const operation = { id, destination, startedAt };
  const setStage = (stage: TeleportStage) =>
    teleportOperation.set({ ...operation, status: "running", stage });

  const warnings = yield* setStage("capturing").pipe(
    Effect.andThen(teleport(setStage)),
    Effect.tapCause((cause) =>
      Effect.ignore(
        teleportOperation.set({
          ...operation,
          status: "failed",
          completedAt: Date.now(),
          error: failureMessage(cause),
        }),
      ),
    ),
  );
  // The next popup starts from a fresh draft.
  yield* Effect.ignore(popupState.remove);
  yield* teleportOperation.set({
    ...operation,
    status: "succeeded",
    completedAt: Date.now(),
    warnings,
  });
  return warnings;
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
        storageState: captured.storageState,
        label: tab.title,
        tags: defaultTeleportTags,
      });
      yield* setStage("opening");
      yield* openWorkbench(connection, sessionId);
      return captured.warnings;
    }),
  );

/** Teleports the tabs the popup selected into a new session or snapshot. */
const teleportTabs = (
  command: TeleportTabsCommand,
  startedAt: number,
  checkpoint?: TeleportCheckpoint,
) =>
  runTeleport(command.id, command.destination, startedAt, (setStage) =>
    Effect.gen(function* () {
      const connection = yield* checkpoint === undefined
        ? requireActiveConnection
        : freshConnection(checkpoint.connectionId);
      if (checkpoint?.stage === "creating") {
        return yield* new CompanionError({
          message:
            "Session creation was interrupted. Check Aperture for the session before trying again.",
        });
      }
      const snapshot = command.destination === "snapshot";
      const snapshotName = command.snapshotName?.trim() ?? "";
      let progress = checkpoint;
      if (progress === undefined) {
        const tabs = yield* Effect.forEach(command.tabIds, getTab);
        if (!tabs.some(({ id }) => id === command.activeTabId)) {
          return yield* new CompanionError({ message: "The active tab is unavailable" });
        }
        // Before anything is made: a name that is taken leaves no session behind.
        if (snapshot && hasScope(connection, "snapshots:read")) {
          yield* requireSnapshotNameFree(connection, snapshotName);
        }
        const captured = yield* captureBrowserState(tabs, command.activeTabId);
        yield* setStage("creating-session");
        const base = { connectionId: connection.id, warnings: captured.warnings };
        // A request that was cut short is not made again while what came of it is unknown.
        yield* saveTeleportCheckpoint(command.id, { ...base, stage: "creating" });
        const sessionId = yield* createSession(connection, {
          storageState: captured.storageState,
          baseSnapshotId: command.baseSnapshotId,
          label: command.label,
          tags: command.tags,
        });
        // A session is opened as it is: its own page shows its state being put in, and
        // this is the last that is done for it. A snapshot is taken of one that has it all.
        progress = { ...base, sessionId, stage: snapshot ? "restoring" : "opening" };
        yield* saveTeleportCheckpoint(command.id, progress);
      }
      const { sessionId, warnings } = progress;
      if (progress.stage === "restoring") {
        yield* setStage("restoring");
        yield* waitForRestored(
          connection,
          sessionId,
          startedAt + Duration.toMillis(teleportLifetime),
        ).pipe(
          // What was made for the snapshot alone is not left behind without one.
          Effect.tapError(() => Effect.ignore(deleteSession(connection, sessionId))),
        );
        progress = { ...progress, stage: "snapshotting" };
        yield* saveTeleportCheckpoint(command.id, progress);
      }
      if (progress.stage === "snapshotting") {
        // One that was being taken when the worker stopped may be there all the same.
        const taken =
          checkpoint?.stage === "snapshotting"
            ? yield* wasSnapshotTaken(connection, sessionId)
            : false;
        if (!taken) {
          yield* setStage("suspending");
          yield* suspendSession(connection, sessionId);
          yield* setStage("creating-snapshot");
          yield* takeSnapshot(connection, sessionId, {
            name: snapshotName,
            description: command.description ?? "",
            tags: command.tags,
          });
        }
        progress = { ...progress, stage: "deleting" };
        yield* saveTeleportCheckpoint(command.id, progress);
      }
      if (progress.stage === "deleting") {
        yield* deleteSession(connection, sessionId);
        yield* saveTeleportCheckpoint(command.id, { ...progress, stage: "opening" });
      }
      yield* setStage("opening");
      if (snapshot) {
        yield* openSnapshots(connection);
      } else {
        yield* openWorkbench(connection, sessionId);
      }
      return warnings;
    }),
  );

const requiredOrigins = (command: CompanionCommand) =>
  command.type !== "teleport-tabs"
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
    yield* Effect.ignore(
      connectionOperation.set({
        id: command.id,
        method: command.type === "connect-oauth" ? "oauth" : "token",
        startedAt,
        status: "failed",
        error: error.message,
      }),
    );
    yield* respond(command.id, ConnectResult, { ok: false, error });
  }
});

const runPendingCommand = Effect.fnUntraced(function* ({
  command,
  createdAt,
  teleport,
}: PendingCommand) {
  if (command.type !== "teleport-tabs") {
    const connection = yield* command.type === "connect-oauth"
      ? connectWithOAuth(command.origin)
      : connect(command.origin, command.token);
    yield* connectionOperation.set({
      id: command.id,
      method: command.type === "connect-oauth" ? "oauth" : "token",
      startedAt: createdAt,
      status: "succeeded",
      connectionId: connection.id,
    });
    yield* respond(command.id, ConnectResult, { ok: true, connectionId: connection.id });
  } else {
    const warnings = yield* teleportTabs(command, createdAt, teleport);
    yield* respond(command.id, TeleportTabsResult, { ok: true, warnings });
  }
});

/** Runs a pending command once its origins are granted, or fails it once it expired. */
const resume = Effect.fnUntraced(function* (id: string) {
  const stored = pendingCommand(id);
  const pending = Option.getOrNull(yield* stored.get);
  if (pending === null) return;
  const expired =
    Date.now() - pending.createdAt >=
    Duration.toMillis(pending.teleport === undefined ? pendingCommandLifetime : teleportLifetime);
  if (!expired && pending.teleport === undefined && !(yield* hasOrigins(pending.origins))) return;

  yield* (
    expired
      ? Effect.fail(
          new CompanionError({
            message:
              pending.teleport === undefined
                ? notGiven(
                    pending.origins,
                    pending.command.type === "teleport-tabs" ? "teleport" : "connect",
                  )
                : "The teleport took longer than 10 minutes. Check its session in Aperture.",
          }),
        )
      : runPendingCommand(pending)
  ).pipe(
    Effect.catchCause((cause) => failCommand(pending.command, pending.createdAt, cause)),
    Effect.ensuring(Effect.ignore(stored.remove)),
  );
});

// Several events resume a command; it runs once at a time.
const resumePendingCommand = (id: string) =>
  Effect.suspend(() => {
    requestedCommandIds.add(id);
    if (runningCommandIds.has(id)) return Effect.void;
    runningCommandIds.add(id);
    return Effect.gen(function* () {
      // Permission approval can arrive while permissions.contains is still resolving.
      // Keep that wakeup so an earlier negative result cannot strand the command.
      do {
        requestedCommandIds.delete(id);
        yield* resume(id).pipe(Effect.ignore);
      } while (requestedCommandIds.has(id));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          runningCommandIds.delete(id);
          requestedCommandIds.delete(id);
        }),
      ),
    );
  });

const resumePendingCommands = listPendingCommands.pipe(
  Effect.flatMap((pending) =>
    Effect.forEach(pending, ({ command }) => resumePendingCommand(command.id), {
      concurrency: "unbounded",
      discard: true,
    }),
  ),
  Effect.andThen(listPendingCommands),
  Effect.flatMap((pending) =>
    pending.length === 0
      ? chromeCall("alarms.clear", () => chrome.alarms.clear(pendingCommandsAlarm))
      : chromeCall("alarms.create", () =>
          chrome.alarms.create(pendingCommandsAlarm, { periodInMinutes: 0.5 }),
        ),
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
    } else {
      yield* connectionOperation.set({
        id: command.id,
        method: command.type === "connect-oauth" ? "oauth" : "token",
        startedAt: createdAt,
        status: "running",
      });
    }
    yield* pendingCommand(command.id).set({ command, origins, createdAt });
    yield* chromeCall("alarms.create", () =>
      chrome.alarms.create(pendingCommandsAlarm, { periodInMinutes: 0.5 }),
    );
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === pendingCommandsAlarm) run(resumePendingCommands);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const command = decodeCommand(message);
  if (Option.isNone(command)) return false;
  responders.set(command.value.id, sendResponse);
  if (command.value.type === "list-snapshots") {
    const { id, connectionId } = command.value;
    // Refresh happens in the worker so closing the popup cannot lose rotated credentials.
    run(
      Effect.gen(function* () {
        const connection = yield* freshConnection(connectionId);
        const snapshots = yield* listSnapshots(connection);
        yield* respond(id, ListSnapshotsResult, { ok: true, snapshots });
      }).pipe(
        Effect.catchCause((cause) =>
          respond(id, ListSnapshotsResult, { ok: false, error: commandError(cause) }),
        ),
      ),
    );
  } else if (command.value.type === "cancel") {
    const { id, commandId } = command.value;
    run(
      cancelPending(commandId).pipe(
        // Whoever sent the command that was taken back is answered as well.
        Effect.tap((taken) =>
          taken === null
            ? Effect.void
            : respond(commandId, CommandFailed, {
                ok: false,
                error: new CompanionError({ message: "Access was not given" }),
              }),
        ),
        Effect.andThen(respond(id, CancelResult, { ok: true })),
        Effect.catchCause((cause) =>
          respond(id, CancelResult, { ok: false, error: commandError(cause) }),
        ),
      ),
    );
  } else if (command.value.type === "disconnect") {
    const { id, connectionId } = command.value;
    run(
      removeConnection(connectionId).pipe(
        Effect.andThen(respond(id, DisconnectResult, { ok: true })),
        Effect.catchCause((cause) =>
          respond(id, DisconnectResult, { ok: false, error: commandError(cause) }),
        ),
      ),
    );
  } else {
    run(queueCommand(command.value));
  }
  // Keeps sendResponse valid until the command finishes.
  return true;
});

run(resumePendingCommands);
