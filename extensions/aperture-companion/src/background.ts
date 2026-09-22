import {
  createSession,
  getConnection,
  openSnapshots,
  openWorkbench,
  promoteSession,
} from "./connection.ts";
import { captureBrowserState, requestCapturePermissions } from "./capture.ts";
import { teleportTabsCommandSchema, type TeleportTabsCommand } from "./commands.ts";
import { clearPopupState } from "./popup-state.ts";
import { saveTeleportOperation, type TeleportStage } from "./teleport-operation.ts";

const menuId = "teleport-page-to-aperture";
const defaultTags = { source: "aperture-companion", action: "teleport" };

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const parsed = teleportTabsCommandSchema.safeParse(message);
  if (!parsed.success) {
    return false;
  }
  void runTeleportOperation(parsed.data.destination, (setStage) =>
    teleportTabs(parsed.data, setStage),
  ).then(
    (warnings) => sendResponse({ ok: true, warnings }),
    async (error: unknown) => {
      await showFailureBadge();
      sendResponse({ ok: false, error: errorMessage(error) });
    },
  );
  return true;
});

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
  if (!tabs.some(({ id }) => id === command.authenticatedTabId)) {
    throw new Error("The authenticated tab is unavailable");
  }
  const captured = await captureBrowserState(tabs, command.authenticatedTabId);
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
): Promise<string[]> {
  const startedAt = Date.now();
  const id = crypto.randomUUID();
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
