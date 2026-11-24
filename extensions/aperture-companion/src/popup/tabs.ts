import * as Effect from "effect/Effect";
import { chromeCall, CompanionError, isWebURL } from "../chrome.ts";

export interface BrowserWindowTabs {
  id: number;
  label: string;
  tabs: chrome.tabs.Tab[];
}

export const activeTab = chromeCall("tabs.query", () =>
  chrome.tabs.query({ active: true, currentWindow: true }),
).pipe(Effect.map((tabs) => tabs[0] ?? null));

/** Normal windows with teleportable tabs, the current window first. */
export const browserWindows = (currentWindowId: number | undefined) =>
  chromeCall("windows.getAll", () =>
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
  ).pipe(Effect.map((windows) => groupTabsByWindow(windows, currentWindowId)));

/** Tab IDs to select by default: the current tab, when it can be teleported. */
export function currentTabIds(currentTab: chrome.tabs.Tab | null): number[] {
  return currentTab?.id === undefined || !isWebURL(currentTab.url) ? [] : [currentTab.id];
}

function groupTabsByWindow(
  windows: chrome.windows.Window[],
  currentWindowId: number | undefined,
): BrowserWindowTabs[] {
  const grouped: Array<{ id: number; tabs: chrome.tabs.Tab[] }> = [];
  for (const window of windows) {
    if (window.id === undefined) continue;
    const tabs = (window.tabs ?? []).filter(({ url }) => isWebURL(url));
    if (tabs.length > 0) grouped.push({ id: window.id, tabs });
  }

  grouped.sort((left, right) => {
    if (left.id === currentWindowId) return -1;
    if (right.id === currentWindowId) return 1;
    return 0;
  });
  return grouped.map(({ id, tabs }, index) => {
    const windowLabel = id === currentWindowId ? "Current window" : `Window ${index + 1}`;
    const activeTitle = tabs.find((tab) => tab.active)?.title?.trim();
    return {
      id,
      label: activeTitle ? `${windowLabel} · ${activeTitle}` : windowLabel,
      tabs,
    };
  });
}

/** Drops tabs that no longer exist and keeps the current tab selected. */
export function reconcileTabIds(
  tabIds: readonly number[],
  browserWindows: BrowserWindowTabs[],
  currentTab: chrome.tabs.Tab | null,
): number[] {
  const availableTabIds = new Set(
    browserWindows.flatMap(({ tabs }) => tabs.flatMap(({ id }) => (id === undefined ? [] : [id]))),
  );
  const reconciled = [...new Set(tabIds)].filter((tabId) => availableTabIds.has(tabId));
  if (
    currentTab?.id !== undefined &&
    isWebURL(currentTab.url) &&
    availableTabIds.has(currentTab.id) &&
    !reconciled.includes(currentTab.id)
  ) {
    reconciled.unshift(currentTab.id);
  }
  return reconciled;
}

export function selectedTabsLabel(
  selectedTabIds: readonly number[],
  currentTab: chrome.tabs.Tab | null,
  browserWindows: BrowserWindowTabs[],
): string {
  if (selectedTabIds.length === 0) return "Select tabs";
  if (selectedTabIds.length > 1) return `${selectedTabIds.length} tabs`;
  const selectedTabId = selectedTabIds[0];
  if (selectedTabId === currentTab?.id) return "Current tab";
  const selectedTab = browserWindows
    .flatMap((browserWindow) => browserWindow.tabs)
    .find((tab) => tab.id === selectedTabId);
  return selectedTab?.title?.trim() || "1 tab";
}

export const requireTabId = (tab: chrome.tabs.Tab) =>
  tab.id === undefined
    ? Effect.fail(new CompanionError({ message: "The browser tab is unavailable" }))
    : Effect.succeed(tab.id);

export function tabUrlLabel(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}
