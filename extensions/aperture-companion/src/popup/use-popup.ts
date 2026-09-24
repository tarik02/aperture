import { entriesToTags, type TagEntry } from "@aperture/ui/components/tag-editor";
import { useEffect, useState, type FormEvent } from "react";
import { requestCapturePermissions } from "../capture.ts";
import {
  connectResultSchema,
  teleportTabsResultSchema,
  type TeleportTabsCommand,
} from "../commands.ts";
import {
  getConnection,
  getConnectionDraft,
  hasScope,
  listConnections,
  listSnapshots,
  normalizeConnectionOrigin,
  removeConnection,
  reorderConnection,
  requestConnectionPermission,
  saveConnection,
  saveConnectionDraft,
  selectConnection,
  type Connection,
  type ConnectionDraft,
} from "../connection.ts";
import {
  getPopupState,
  savePopupState,
  type PopupScreen,
  type PopupState,
  type TeleportDestination,
} from "../popup-state.ts";
import {
  clearCompletedTeleportOperation,
  getTeleportOperation,
  isTeleportOperationRunning,
  subscribeToTeleportOperation,
  type TeleportOperation,
} from "../teleport-operation.ts";
import {
  errorStatus,
  statusFromTeleportOperation,
  teleportCreatedStatus,
  teleportProgressLabel,
  type Status,
} from "./status.tsx";
import {
  activeTab,
  currentTabIds,
  groupTabsByWindow,
  isWebURL,
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
export type TeleportDraft = Omit<PopupState, "connectionId" | "screen">;

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

export type Popup = ReturnType<typeof usePopup>;

export function usePopup() {
  const [initialized, setInitialized] = useState(false);
  const [screen, setScreen] = useState<PopupScreen>("home");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>({
    origin: "",
    token: "",
  });
  const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null);
  const [browserWindows, setBrowserWindows] = useState<BrowserWindowTabs[]>([]);
  const [snapshots, setSnapshots] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<TeleportDraft>(() => initialDraft(null));
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [teleportOperation, setTeleportOperation] = useState<TeleportOperation | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const teleportRunning = isTeleportOperationRunning(teleportOperation);
  const busy = pendingAction !== null || teleportRunning;
  const canCreateSnapshot = connection !== null && hasScope(connection, "snapshots:write");

  useEffect(() => {
    const unsubscribe = subscribeToTeleportOperation(showTeleportOperation);
    void initialize()
      .catch((error: unknown) => setStatus(errorStatus(error)))
      .finally(() => setInitialized(true));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!initialized) {
      return;
    }
    void savePopupState({ connectionId: connection?.id ?? null, screen, ...draft }).catch(
      (error: unknown) => setStatus(errorStatus(error)),
    );
  }, [initialized, connection?.id, screen, draft]);

  function showTeleportOperation(operation: TeleportOperation | null) {
    setTeleportOperation(operation);
    const operationStatus = statusFromTeleportOperation(operation);
    if (operationStatus !== null) {
      setStatus(operationStatus);
    }
    if (operation !== null && !isTeleportOperationRunning(operation)) {
      void clearCompletedTeleportOperation(operation.id);
    }
  }

  async function initialize() {
    const [storedConnections, storedConnection, storedDraft, active, restoredState, operation] =
      await Promise.all([
        listConnections(),
        getConnection(),
        getConnectionDraft(),
        activeTab(),
        getPopupState(),
        getTeleportOperation(),
      ]);
    setConnections(storedConnections);
    setConnectionDraft(storedDraft);
    setCurrentTab(active);
    showTeleportOperation(operation);
    if (storedConnection === null) {
      setScreen("add-connection");
      return;
    }
    setConnection(storedConnection);
    await loadBrowserContext(storedConnection, active, restoredState);
  }

  // Loads tabs and snapshots for a connection, restoring the saved draft when it belongs to it.
  async function loadBrowserContext(
    activeConnection: Connection,
    active: chrome.tabs.Tab | null,
    restored: PopupState | null = null,
  ) {
    const [windows, loadedSnapshots] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      hasScope(activeConnection, "snapshots:read")
        ? listSnapshots(activeConnection).catch(() => null)
        : Promise.resolve(null),
    ]);
    const groupedWindows = groupTabsByWindow(windows, active?.windowId);

    setBrowserWindows(groupedWindows);
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
      selectedTabIds: reconcileTabIds(restored.selectedTabIds, groupedWindows, active),
      draftTabIds: reconcileTabIds(restored.draftTabIds, groupedWindows, active),
      selectedSnapshot: snapshotAvailable ? restored.selectedSnapshot : blankSnapshot,
      destination:
        restored.destination === "snapshot" && hasScope(activeConnection, "snapshots:write")
          ? "snapshot"
          : "session",
      advanced: restored.advanced,
      resourceName: restored.resourceName,
      description: restored.description,
      tags: restored.tags,
    });
    setScreen(restored.screen);
  }

  // Runs a user action, reporting its failure as the status. Returns whether it succeeded.
  async function run(pending: PendingAction, action: () => Promise<void>): Promise<boolean> {
    setPendingAction(pending);
    setStatus(null);
    try {
      await action();
      return true;
    } catch (error) {
      setStatus(errorStatus(error));
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  function updateDraft(patch: Partial<TeleportDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function selectedOrCurrentTabIds(): number[] {
    return draft.selectedTabIds.length > 0 ? draft.selectedTabIds : currentTabIds(currentTab);
  }

  function requireCurrentTabId(): number {
    if (currentTab === null || !isWebURL(currentTab.url)) {
      throw new Error("The current page cannot be teleported");
    }
    return requireTabId(currentTab);
  }

  function requireSelectedTabs(tabIds: number[]): chrome.tabs.Tab[] {
    const selected = new Set(tabIds);
    const tabs = browserWindows
      .flatMap((browserWindow) => browserWindow.tabs)
      .filter((tab) => tab.id !== undefined && selected.has(tab.id));
    if (tabs.length === 0) {
      throw new Error("Select at least one tab");
    }
    return tabs;
  }

  async function sendTeleport(command: TeleportTabsCommand) {
    const baseSnapshotName =
      draft.selectedSnapshot === blankSnapshot || snapshots === null
        ? undefined
        : draft.selectedSnapshot;
    const response = teleportTabsResultSchema.parse(
      await chrome.runtime.sendMessage({ ...command, baseSnapshotName }),
    );
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response;
  }

  const actions = {
    showScreen(next: PopupScreen) {
      setStatus(null);
      setScreen(next);
    },

    updateConnectionDraft(next: ConnectionDraft) {
      setConnectionDraft(next);
      void saveConnectionDraft(next).catch((error: unknown) => setStatus(errorStatus(error)));
    },

    async connect(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      await run("connect", async () => {
        normalizeConnectionOrigin(connectionDraft.origin);
        if (connectionDraft.token.trim() === "") {
          throw new Error("API token is required");
        }
        const responsePromise = chrome.runtime.sendMessage({
          type: "connect",
          id: crypto.randomUUID(),
          origin: connectionDraft.origin,
          token: connectionDraft.token,
        });
        try {
          await requestConnectionPermission(connectionDraft.origin);
        } catch (error) {
          void responsePromise.catch(() => undefined);
          throw error;
        }
        const response = connectResultSchema.parse(await responsePromise);
        if (!response.ok) {
          throw new Error(response.error);
        }
        const storedConnections = await listConnections();
        const connected = storedConnections.find(({ id }) => id === response.connectionId);
        if (connected === undefined) {
          throw new Error("The Aperture connection is unavailable");
        }
        setConnections(storedConnections);
        setConnection(connected);
        setConnectionDraft((current) => ({ ...current, token: "" }));
        setScreen("home");
        await loadBrowserContext(connected, currentTab);
        setStatus({ message: "Connected.", kind: "neutral" });
      });
    },

    async selectConnection(id: string): Promise<boolean> {
      if (id === connection?.id) {
        return true;
      }
      return run("connection", async () => {
        const selected = connections.find((candidate) => candidate.id === id);
        if (selected === undefined) {
          throw new Error("The Aperture connection is unavailable");
        }
        await selectConnection(id);
        setConnection(selected);
        await loadBrowserContext(selected, currentTab);
        setStatus(null);
      });
    },

    async removeConnection(id: string): Promise<boolean> {
      return run("remove", async () => {
        await removeConnection(id);
        const [remaining, activeConnection] = await Promise.all([
          listConnections(),
          getConnection(),
        ]);
        setConnections(remaining);
        setConnection(activeConnection);
        if (activeConnection === null) {
          setSnapshots(null);
          setScreen("add-connection");
        } else if (activeConnection.id !== connection?.id) {
          await loadBrowserContext(activeConnection, currentTab);
        }
        setStatus({ message: "Connection removed.", kind: "neutral" });
      });
    },

    async reorderConnection(sourceId: string, destinationId: string, placement: DropPlacement) {
      await run("reorder", async () => {
        setConnections(await reorderConnection(sourceId, destinationId, placement));
        setStatus(null);
      });
    },

    async changeChannel(channel: string | null) {
      if (channel === null || connection === null) {
        return;
      }
      await run("channel", async () => {
        const updated = { ...connection, channel };
        await saveConnection(updated);
        setConnection(updated);
        setConnections((current) =>
          current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
        );
        setStatus({ message: "Browser channel saved.", kind: "neutral" });
      });
    },

    updateDraft,

    setDestination(destination: TeleportDestination) {
      if (destination === "session" || canCreateSnapshot) {
        updateDraft({ destination });
        setStatus(null);
      }
    },

    openTabPicker() {
      updateDraft({ draftTabIds: selectedOrCurrentTabIds() });
      actions.showScreen("tabs");
    },

    closeTabPicker() {
      updateDraft({ draftTabIds: selectedOrCurrentTabIds() });
      actions.showScreen("home");
    },

    toggleDraftTab(tabId: number, checked: boolean) {
      setDraft((current) => ({
        ...current,
        draftTabIds: checked
          ? [tabId, ...current.draftTabIds.filter((id) => id !== tabId)]
          : current.draftTabIds.filter((id) => id !== tabId),
      }));
    },

    activateDraftTab(tabId: number) {
      setDraft((current) => ({
        ...current,
        draftTabIds: current.draftTabIds.includes(tabId)
          ? [tabId, ...current.draftTabIds.filter((id) => id !== tabId)]
          : current.draftTabIds,
      }));
    },

    confirmTabs() {
      try {
        const tabs = requireSelectedTabs(draft.draftTabIds);
        if (!tabs.some((tab) => tab.id === requireCurrentTabId())) {
          throw new Error("The current tab must stay selected");
        }
        updateDraft({ selectedTabIds: draft.draftTabIds });
        actions.showScreen("home");
      } catch (error) {
        setStatus(errorStatus(error));
      }
    },

    async teleport() {
      await run("teleport", async () => {
        const selectedTabIds = selectedOrCurrentTabIds();
        const tabs = requireSelectedTabs(selectedTabIds);
        const currentTabId = requireCurrentTabId();
        if (!tabs.some((tab) => tab.id === currentTabId)) {
          throw new Error("Select the current tab to teleport its browser state");
        }
        const activeTabId =
          selectedTabIds.find((tabId) => tabs.some((tab) => tab.id === tabId)) ?? currentTabId;
        const { destination } = draft;
        const name = draft.resourceName.trim();
        if (destination === "snapshot" && name === "") {
          updateDraft({ advanced: true });
          throw new Error("Snapshot name is required");
        }
        const resultPromise = sendTeleport({
          type: "teleport-tabs",
          id: crypto.randomUUID(),
          tabIds: tabs.map(requireTabId),
          activeTabId,
          destination,
          label: name,
          tags: entriesToTags(draft.tags),
          ...(destination === "snapshot"
            ? { snapshotName: name, description: draft.description.trim() }
            : {}),
        });
        try {
          await requestCapturePermissions(tabs);
        } catch (error) {
          void resultPromise.catch(() => undefined);
          throw error;
        }
        const result = await resultPromise;
        setDraft(initialDraft(currentTab));
        setScreen("home");
        setStatus(teleportCreatedStatus(destination, result.warnings));
      });
    },

    reset() {
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
