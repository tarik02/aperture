import { entriesToTags, type TagEntry } from "@aperture-browser/ui/components/tag-editor";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { useEffect, useState, type FormEvent } from "react";
import { requestCapturePermissions } from "../capture.ts";
import { chromeCall, CompanionError, isWebURL, type ChromeError } from "../chrome.ts";
import {
  ConnectResult,
  TeleportTabsResult,
  type CommandFailed,
  type CompanionCommand,
  type TeleportTabsCommand,
} from "../commands.ts";
import {
  activeConnection,
  connectionDraft as storedConnectionDraft,
  emptyConnectionDraft,
  hasScope,
  listConnections,
  listSnapshots,
  normalizeConnectionOrigin,
  removeConnection,
  reorderConnection,
  requestConnectionPermission,
  saveConnection,
  selectConnection,
  type Connection,
  type ConnectionDraft,
} from "../connection.ts";
import { popupState, type PopupScreen, type PopupState } from "../popup-state.ts";
import type { TeleportDestination } from "../schema.ts";
import {
  clearCompletedTeleportOperation,
  isTeleportRunning,
  teleportOperation as storedTeleportOperation,
  type TeleportOperation,
} from "../teleport-operation.ts";
import {
  failureStatus,
  statusFromTeleportOperation,
  teleportCreatedStatus,
  teleportProgressLabel,
  type Status,
} from "./status.tsx";
import {
  activeTab,
  browserWindows as loadBrowserWindows,
  currentTabIds,
  reconcileTabIds,
  requireTabId,
  type BrowserWindowTabs,
} from "./tabs.ts";

export const blankSnapshot = "__blank__";

const defaultTags: TagEntry[] = [
  { key: "source", value: "aperture-companion" },
  { key: "action", value: "teleport" },
];

export type DropPlacement = "before" | "after";

type PendingAction = "connect" | "connection" | "remove" | "reorder" | "channel" | "teleport";

/** Everything the user has set up for the next teleport; persisted across popup reopenings. */
export type TeleportDraft = Omit<PopupState, "connectionId" | "screen" | "tags"> & {
  tags: TagEntry[];
};

function initialDraft(currentTab: chrome.tabs.Tab | null): TeleportDraft {
  const tabIds = currentTabIds(currentTab);
  return {
    selectedTabIds: tabIds,
    draftTabIds: tabIds,
    selectedSnapshot: blankSnapshot,
    destination: "session",
    advanced: false,
    resourceName: currentTab?.title?.trim() ?? "",
    description: "",
    tags: defaultTags,
  };
}

const failure = (message: string) => new CompanionError({ message });

/**
 * Hands a command to the service worker, then asks for the access it waits for. Both calls
 * happen before the fiber first yields, while the click still counts as a user gesture.
 * Chromium may close the popup to ask; the worker then carries on with the command alone.
 */
const sendCommand = <A extends { readonly ok: true } | CommandFailed, I>(
  command: CompanionCommand,
  resultSchema: Schema.Codec<A, I>,
  requestAccess: Effect.Effect<void, CompanionError | ChromeError>,
) =>
  Effect.gen(function* () {
    const response = yield* Effect.sync(() => {
      const sent: Promise<unknown> = chrome.runtime.sendMessage(command);
      // Awaited below, unless the access request fails first.
      sent.catch(() => undefined);
      return sent;
    });
    yield* requestAccess;
    const message = yield* chromeCall("runtime.sendMessage", () => response);
    const result = yield* Schema.decodeUnknownEffect(resultSchema)(message);
    if (isFailed(result)) return yield* Effect.fail(result.error);
    return result as Exclude<A, CommandFailed>;
  });

const isFailed = (result: { readonly ok: boolean }): result is CommandFailed => !result.ok;

export type Popup = ReturnType<typeof usePopup>;

export function usePopup() {
  const [initialized, setInitialized] = useState(false);
  const [screen, setScreen] = useState<PopupScreen>("home");
  const [connections, setConnections] = useState<readonly Connection[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>(emptyConnectionDraft);
  const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null);
  const [browserWindows, setBrowserWindows] = useState<BrowserWindowTabs[]>([]);
  const [snapshots, setSnapshots] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<TeleportDraft>(() => initialDraft(null));
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [teleportOperation, setTeleportOperation] = useState<TeleportOperation | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const teleportRunning = isTeleportRunning(teleportOperation);
  const busy = pendingAction !== null || teleportRunning;
  const canCreateSnapshot = connection !== null && hasScope(connection, "snapshots:write");

  // The service worker reports teleport progress through storage, also for teleports that
  // started before this popup opened.
  function showTeleportOperation(operation: TeleportOperation | null) {
    setTeleportOperation(operation);
    const operationStatus = statusFromTeleportOperation(operation);
    if (operationStatus !== null) setStatus(operationStatus);
    if (operation !== null && !isTeleportRunning(operation)) {
      Effect.runFork(Effect.ignore(clearCompletedTeleportOperation(operation.id)));
    }
  }

  useEffect(() => {
    const updates = Effect.runFork(
      Stream.runForEach(storedTeleportOperation.changes, (operation) =>
        Effect.sync(() => showTeleportOperation(Option.getOrNull(operation))),
      ),
    );
    void Effect.runPromiseExit(initialize).then((exit) => {
      if (Exit.isFailure(exit)) setStatus(failureStatus(exit.cause));
      setInitialized(true);
    });
    return () => {
      Effect.runFork(Fiber.interrupt(updates));
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    void Effect.runPromiseExit(
      popupState.set({ connectionId: connection?.id ?? null, screen, ...draft }),
    ).then((exit) => {
      if (Exit.isFailure(exit)) setStatus(failureStatus(exit.cause));
    });
  }, [initialized, connection?.id, screen, draft]);

  const initialize = Effect.gen(function* () {
    const [stored, storedConnection, storedDraft, active, restored, operation] = yield* Effect.all(
      [
        listConnections,
        activeConnection,
        storedConnectionDraft.get,
        activeTab,
        popupState.get,
        storedTeleportOperation.get,
      ],
      { concurrency: "unbounded" },
    );
    setConnections(stored);
    setConnectionDraft(Option.getOrElse(storedDraft, () => emptyConnectionDraft));
    setCurrentTab(active);
    showTeleportOperation(Option.getOrNull(operation));
    if (storedConnection === null) {
      setScreen("add-connection");
      return;
    }
    setConnection(storedConnection);
    yield* loadBrowserContext(storedConnection, active, Option.getOrNull(restored));
  });

  // Loads tabs and snapshots for a connection, restoring the saved draft when it belongs to it.
  const loadBrowserContext = Effect.fnUntraced(function* (
    activeConnection: Connection,
    active: chrome.tabs.Tab | null,
    restored: PopupState | null = null,
  ) {
    const [windows, loadedSnapshots] = yield* Effect.all(
      [
        loadBrowserWindows(active?.windowId),
        hasScope(activeConnection, "snapshots:read")
          ? listSnapshots(activeConnection).pipe(Effect.orElseSucceed(() => null))
          : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );

    setBrowserWindows(windows);
    setSnapshots(loadedSnapshots);
    if (restored?.connectionId !== activeConnection.id) {
      setDraft(initialDraft(active));
      setScreen("home");
      return;
    }
    const snapshotAvailable =
      restored.selectedSnapshot === blankSnapshot ||
      loadedSnapshots?.includes(restored.selectedSnapshot) === true;
    setDraft({
      selectedTabIds: reconcileTabIds(restored.selectedTabIds, windows, active),
      draftTabIds: reconcileTabIds(restored.draftTabIds, windows, active),
      selectedSnapshot: snapshotAvailable ? restored.selectedSnapshot : blankSnapshot,
      destination:
        restored.destination === "snapshot" && hasScope(activeConnection, "snapshots:write")
          ? "snapshot"
          : "session",
      advanced: restored.advanced,
      resourceName: restored.resourceName,
      description: restored.description,
      tags: [...restored.tags],
    });
    setScreen(restored.screen);
  });

  // Runs a user action, reporting its failure as the status. Resolves to whether it succeeded.
  // The action starts synchronously, so access requests in it still see the user gesture.
  function run(pending: PendingAction, action: Effect.Effect<void, unknown>): Promise<boolean> {
    setPendingAction(pending);
    setStatus(null);
    return Effect.runPromiseExit(action).then((exit) => {
      setPendingAction(null);
      if (Exit.isSuccess(exit)) return true;
      setStatus(failureStatus(exit.cause));
      return false;
    });
  }

  function updateDraft(patch: Partial<TeleportDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function selectedOrCurrentTabIds(): readonly number[] {
    return draft.selectedTabIds.length > 0 ? draft.selectedTabIds : currentTabIds(currentTab);
  }

  const requireCurrentTabId = Effect.suspend(() =>
    currentTab === null || !isWebURL(currentTab.url)
      ? Effect.fail(failure("The current page cannot be teleported"))
      : requireTabId(currentTab),
  );

  const requireSelectedTabs = (tabIds: readonly number[]) =>
    Effect.suspend(() => {
      const selected = new Set(tabIds);
      const tabs = browserWindows
        .flatMap((browserWindow) => browserWindow.tabs)
        .filter((tab) => tab.id !== undefined && selected.has(tab.id));
      return tabs.length === 0
        ? Effect.fail(failure("Select at least one tab"))
        : Effect.succeed(tabs);
    });

  const actions = {
    showScreen: (next: PopupScreen) => {
      setStatus(null);
      setScreen(next);
    },

    updateConnectionDraft: (next: ConnectionDraft) => {
      setConnectionDraft(next);
      void Effect.runPromiseExit(storedConnectionDraft.set(next)).then((exit) => {
        if (Exit.isFailure(exit)) setStatus(failureStatus(exit.cause));
      });
    },

    connect: async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const { origin, token } = connectionDraft;
      await run(
        "connect",
        Effect.gen(function* () {
          yield* normalizeConnectionOrigin(origin);
          if (token.trim() === "") return yield* failure("API token is required");
          const result = yield* sendCommand(
            { type: "connect", id: crypto.randomUUID(), origin, token },
            ConnectResult,
            requestConnectionPermission(origin),
          );
          const stored = yield* listConnections;
          const connected = stored.find(({ id }) => id === result.connectionId);
          if (connected === undefined) {
            return yield* failure("The Aperture connection is unavailable");
          }
          setConnections(stored);
          setConnection(connected);
          setConnectionDraft((current) => ({ ...current, token: "" }));
          setScreen("home");
          yield* loadBrowserContext(connected, currentTab);
          setStatus({ message: "Connected.", kind: "neutral" });
        }),
      );
    },

    selectConnection: (id: string): Promise<boolean> => {
      if (id === connection?.id) return Promise.resolve(true);
      return run(
        "connection",
        Effect.gen(function* () {
          const selected = connections.find((candidate) => candidate.id === id);
          if (selected === undefined) {
            return yield* failure("The Aperture connection is unavailable");
          }
          yield* selectConnection(id);
          setConnection(selected);
          yield* loadBrowserContext(selected, currentTab);
        }),
      );
    },

    removeConnection: (id: string): Promise<boolean> => {
      return run(
        "remove",
        Effect.gen(function* () {
          yield* removeConnection(id);
          const [remaining, active] = yield* Effect.all([listConnections, activeConnection]);
          setConnections(remaining);
          setConnection(active);
          if (active === null) {
            setSnapshots(null);
            setScreen("add-connection");
          } else if (active.id !== connection?.id) {
            yield* loadBrowserContext(active, currentTab);
          }
          setStatus({ message: "Connection removed.", kind: "neutral" });
        }),
      );
    },

    reorderConnection: async (
      sourceId: string,
      destinationId: string,
      placement: DropPlacement,
    ) => {
      await run(
        "reorder",
        reorderConnection(sourceId, destinationId, placement).pipe(
          Effect.map((reordered) => setConnections(reordered)),
        ),
      );
    },

    changeChannel: async (channel: string | null) => {
      if (channel === null || connection === null) return;
      const updated = { ...connection, channel };
      await run(
        "channel",
        Effect.gen(function* () {
          yield* saveConnection(updated);
          setConnection(updated);
          setConnections((current) =>
            current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
          );
          setStatus({ message: "Browser channel saved.", kind: "neutral" });
        }),
      );
    },

    updateDraft,

    setDestination: (destination: TeleportDestination) => {
      if (destination === "session" || canCreateSnapshot) {
        updateDraft({ destination });
        setStatus(null);
      }
    },

    openTabPicker: () => {
      updateDraft({ draftTabIds: selectedOrCurrentTabIds() });
      actions.showScreen("tabs");
    },

    closeTabPicker: () => {
      updateDraft({ draftTabIds: selectedOrCurrentTabIds() });
      actions.showScreen("home");
    },

    toggleDraftTab: (tabId: number, checked: boolean) => {
      setDraft((current) => ({
        ...current,
        draftTabIds: checked
          ? [tabId, ...current.draftTabIds.filter((id) => id !== tabId)]
          : current.draftTabIds.filter((id) => id !== tabId),
      }));
    },

    activateDraftTab: (tabId: number) => {
      setDraft((current) => ({
        ...current,
        draftTabIds: current.draftTabIds.includes(tabId)
          ? [tabId, ...current.draftTabIds.filter((id) => id !== tabId)]
          : current.draftTabIds,
      }));
    },

    confirmTabs: () => {
      const exit = Effect.runSyncExit(
        Effect.gen(function* () {
          const tabs = yield* requireSelectedTabs(draft.draftTabIds);
          const currentTabId = yield* requireCurrentTabId;
          if (!tabs.some((tab) => tab.id === currentTabId)) {
            return yield* failure("The current tab must stay selected");
          }
        }),
      );
      if (Exit.isFailure(exit)) {
        setStatus(failureStatus(exit.cause));
        return;
      }
      updateDraft({ selectedTabIds: draft.draftTabIds });
      actions.showScreen("home");
    },

    teleport: async () => {
      await run(
        "teleport",
        Effect.gen(function* () {
          const selectedTabIds = selectedOrCurrentTabIds();
          const tabs = yield* requireSelectedTabs(selectedTabIds);
          const currentTabId = yield* requireCurrentTabId;
          if (!tabs.some((tab) => tab.id === currentTabId)) {
            return yield* failure("Select the current tab to teleport its browser state");
          }
          const activeTabId =
            selectedTabIds.find((tabId) => tabs.some((tab) => tab.id === tabId)) ?? currentTabId;
          const { destination } = draft;
          const name = draft.resourceName.trim();
          if (destination === "snapshot" && name === "") {
            updateDraft({ advanced: true });
            return yield* failure("Snapshot name is required");
          }
          const baseSnapshotName =
            draft.selectedSnapshot === blankSnapshot || snapshots === null
              ? undefined
              : draft.selectedSnapshot;
          const command: TeleportTabsCommand = {
            type: "teleport-tabs",
            id: crypto.randomUUID(),
            tabIds: yield* Effect.forEach(tabs, requireTabId),
            activeTabId,
            destination,
            label: name,
            tags: entriesToTags(draft.tags),
            ...(baseSnapshotName === undefined ? {} : { baseSnapshotName }),
            ...(destination === "snapshot"
              ? { snapshotName: name, description: draft.description.trim() }
              : {}),
          };
          const result = yield* sendCommand(
            command,
            TeleportTabsResult,
            requestCapturePermissions(tabs),
          );
          setDraft(initialDraft(currentTab));
          setScreen("home");
          setStatus(teleportCreatedStatus(destination, result.warnings));
        }),
      );
    },

    reset: () => {
      setDraft(initialDraft(currentTab));
      actions.showScreen("home");
    },
  };

  return {
    initialized,
    screen,
    connections,
    connection,
    connectionDraft,
    currentTab,
    browserWindows,
    snapshots,
    draft,
    status,
    busy,
    canCreateSnapshot,
    selectedTabIds: selectedOrCurrentTabIds(),
    connecting: pendingAction === "connect",
    managingConnection:
      pendingAction === "connection" || pendingAction === "remove" || pendingAction === "reorder",
    teleporting: pendingAction === "teleport" || teleportRunning,
    teleportLabel: teleportProgressLabel(teleportOperation, pendingAction === "teleport"),
    actions,
  };
}
