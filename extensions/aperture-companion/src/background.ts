import {
  connect,
  createSession,
  getConnection,
  normalizeConnectionOrigin,
  openSnapshots,
  openWorkbench,
  promoteSession,
} from "./connection.ts";
import {
  captureBrowserState,
  capturePermissionOrigins,
  requestCapturePermissions,
} from "./capture.ts";
import {
  connectCommandSchema,
  teleportTabsCommandSchema,
  type CompanionCommand,
  type TeleportTabsCommand,
} from "./commands.ts";
import {
  getPendingCommand,
  listPendingCommands,
  pendingCommandLifetimeMs,
  removePendingCommand,
  savePendingCommand,
  type PendingCommand,
} from "./pending-command.ts";
import { clearPopupState } from "./popup-state.ts";
import { saveTeleportOperation, type TeleportStage } from "./teleport-operation.ts";

const menuId = "teleport-page-to-aperture";
const defaultTags = { source: "aperture-companion", action: "teleport" };
const commandResponders = new Map<string, (response: unknown) => void>();
const runningCommandIds = new Set<string>();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() =>
    chrome.contextMenus.create({
      id: menuId,
      title: "Teleport page to Aperture",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    }),
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== menuId || tab?.url === undefined) {
    return;
  }
  void requestCapturePermissions([tab])
    .then(() => runTeleportOperation("session", (setStage) => teleportPage(tab, setStage)))
    .catch(() => showFailureBadge());
});

chrome.permissions.onAdded.addListener(() => {
  void resumePendingCommands();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const connectCommand = connectCommandSchema.safeParse(message);
  if (connectCommand.success) {
    commandResponders.set(connectCommand.data.id, sendResponse);
    void queuePendingCommand(connectCommand.data);
    return true;
  }

  const teleportCommand = teleportTabsCommandSchema.safeParse(message);
  if (!teleportCommand.success) {
    return false;
  }
  commandResponders.set(teleportCommand.data.id, sendResponse);
  void queuePendingCommand(teleportCommand.data);
  return true;
});

async function queuePendingCommand(command: CompanionCommand): Promise<void> {
  try {
    const existing = await listPendingCommands();
    await Promise.all(
      existing
        .filter((pending) => pending.command.type === command.type)
        .map((pending) => removePendingCommand(pending.command.id)),
    );

    const createdAt = Date.now();
    const origins = await requiredOrigins(command);
    if (command.type === "teleport-tabs") {
      await saveTeleportOperation({
        id: command.id,
        destination: command.destination,
        startedAt: createdAt,
        status: "running",
        stage: "requesting-access",
      });
    }
    await savePendingCommand(command, origins, createdAt);
    await resumePendingCommand(command.id);
    setTimeout(() => void resumePendingCommand(command.id), pendingCommandLifetimeMs);
  } catch (error) {
    await failCommand(command, Date.now(), error);
  }
}

async function requiredOrigins(command: CompanionCommand): Promise<string[]> {
  if (command.type === "connect") {
    return [`${normalizeConnectionOrigin(command.origin)}/*`];
  }
  const tabs = await Promise.all(command.tabIds.map((tabId) => chrome.tabs.get(tabId)));
  return capturePermissionOrigins(tabs);
}

async function resumePendingCommands(): Promise<void> {
  const pendingCommands = await listPendingCommands();
  await Promise.all(pendingCommands.map(({ command }) => resumePendingCommand(command.id)));
}

async function resumePendingCommand(id: string): Promise<void> {
  if (runningCommandIds.has(id)) {
    return;
  }
  runningCommandIds.add(id);
  try {
    const pending = await getPendingCommand(id);
    if (pending === null) {
      return;
    }
    if (Date.now() - pending.createdAt >= pendingCommandLifetimeMs) {
      await failCommand(pending.command, pending.createdAt, new Error("Access was not granted"));
      await removePendingCommand(id);
      return;
    }
    if (!(await chrome.permissions.contains({ origins: pending.origins }))) {
      return;
    }
    await runPendingCommand(pending);
    await removePendingCommand(id);
  } catch (error) {
    const pending = await getPendingCommand(id);
    if (pending !== null) {
      await failCommand(pending.command, pending.createdAt, error);
      await removePendingCommand(id);
    }
  } finally {
    runningCommandIds.delete(id);
  }
}

async function runPendingCommand(pending: PendingCommand): Promise<void> {
  const { command } = pending;
  if (command.type === "connect") {
    const connected = await connect(command.origin, command.token);
    respondToCommand(command.id, { ok: true, connectionId: connected.id });
    return;
  }
  const warnings = await runTeleportOperation(
    command.destination,
    (setStage) => teleportTabs(command, setStage),
    command.id,
    pending.createdAt,
  );
  respondToCommand(command.id, { ok: true, warnings });
}

async function failCommand(
  command: CompanionCommand,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  if (command.type === "teleport-tabs") {
    await saveTeleportOperation({
      id: command.id,
      destination: command.destination,
      startedAt,
      status: "failed",
      completedAt: Date.now(),
      error: message,
    }).catch(() => undefined);
    await showFailureBadge();
  }
  respondToCommand(command.id, { ok: false, error: message });
}

function respondToCommand(id: string, response: unknown): void {
  const respond = commandResponders.get(id);
  commandResponders.delete(id);
  respond?.(response);
}

async function teleportPage(
  tab: chrome.tabs.Tab,
  setStage: (stage: TeleportStage) => Promise<void>,
): Promise<string[]> {
  const connection = await getConnection();
  if (connection === null) {
    throw new Error("Aperture is not connected");
  }
  if (tab.url === undefined || tab.id === undefined || !isWebURL(tab.url)) {
    throw new Error("Only HTTP and HTTPS tabs can be teleported");
  }
  const captured = await captureBrowserState([tab], tab.id);
  await setStage("creating-session");
  const sessionId = await createSession(connection, {
    targets: captured.targets,
    storageState: captured.storageState,
    label: tab.title,
    tags: defaultTags,
    waitForReady: false,
  });
  await setStage("opening");
  await openWorkbench(connection, sessionId);
  return captured.warnings;
}

async function teleportTabs(
  command: TeleportTabsCommand,
  setStage: (stage: TeleportStage) => Promise<void>,
): Promise<string[]> {
  const connection = await getConnection();
  if (connection === null) {
    throw new Error("Aperture is not connected");
  }
  const tabs = await Promise.all(command.tabIds.map((tabId) => chrome.tabs.get(tabId)));
  if (!tabs.some(({ id }) => id === command.activeTabId)) {
    throw new Error("The active tab is unavailable");
  }
  const captured = await captureBrowserState(tabs, command.activeTabId);
  await setStage("creating-session");
  const sessionId = await createSession(connection, {
    targets: captured.targets,
    storageState: captured.storageState,
    baseSnapshotName: command.baseSnapshotName,
    label: command.label,
    tags: command.tags,
    waitForReady: command.destination === "snapshot",
  });
  if (command.destination === "snapshot") {
    await setStage("creating-snapshot");
    await promoteSession(
      connection,
      sessionId,
      command.snapshotName ?? "",
      command.description ?? "",
      command.tags,
    );
    await setStage("opening");
    await openSnapshots(connection);
  } else {
    await setStage("opening");
    await openWorkbench(connection, sessionId);
  }
  return captured.warnings;
}

async function runTeleportOperation(
  destination: "session" | "snapshot",
  operation: (setStage: (stage: TeleportStage) => Promise<void>) => Promise<string[]>,
  id: string = crypto.randomUUID(),
  startedAt = Date.now(),
): Promise<string[]> {
  const setStage = (stage: TeleportStage) =>
    saveTeleportOperation({ id, destination, startedAt, status: "running", stage });
  await setStage("capturing");
  try {
    const warnings = await operation(setStage);
    await clearPopupState().catch(() => undefined);
    await saveTeleportOperation({
      id,
      destination,
      startedAt,
      status: "succeeded",
      completedAt: Date.now(),
      warnings,
    });
    return warnings;
  } catch (error) {
    await saveTeleportOperation({
      id,
      destination,
      startedAt,
      status: "failed",
      completedAt: Date.now(),
      error: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }
}

async function showFailureBadge(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
  await chrome.action.setBadgeText({ text: "!" });
  setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 5000);
}

function isWebURL(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed";
}

void resumePendingCommands();
