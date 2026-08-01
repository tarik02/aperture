const nativeHost = "me.tarik02.aperture.tab_window_enforcer";
const markerPath = "marker.html";

let nativePort = null;
let nextRequestId = 0;
let pendingRequests = new Map();
let reconcileChain = Promise.resolve();
let reconcileTimer = null;

chrome.runtime.onInstalled.addListener(scheduleReconcile);
chrome.runtime.onStartup.addListener(scheduleReconcile);
chrome.tabs.onCreated.addListener(scheduleReconcile);
chrome.tabs.onUpdated.addListener(scheduleReconcile);
chrome.tabs.onAttached.addListener(scheduleReconcile);
chrome.tabs.onDetached.addListener(scheduleReconcile);
chrome.tabs.onRemoved.addListener(scheduleReconcile);
chrome.windows.onCreated.addListener(scheduleReconcile);
chrome.windows.onRemoved.addListener((windowId) => {
  void forgetManagedWindow(windowId);
  scheduleReconcile();
});

scheduleReconcile();

function scheduleReconcile() {
  if (reconcileTimer !== null) {
    clearTimeout(reconcileTimer);
  }
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileChain = reconcileChain.then(reconcile).catch((error) => {
      console.error("Aperture window reconciliation failed", error);
      scheduleReconcile();
    });
  }, 25);
}

async function reconcile() {
  const stored = await chrome.storage.session.get("managedWindows");
  const managedWindows = stored.managedWindows ?? {};
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal", "popup"] });
  const liveWindowIds = new Set(windows.map((window) => String(window.id)));

  for (const windowId of Object.keys(managedWindows)) {
    if (!liveWindowIds.has(windowId)) {
      delete managedWindows[windowId];
    }
  }

  for (const window of windows) {
    const userTabs = (window.tabs ?? []).filter(isUserTab);
    if (userTabs.length === 0) {
      continue;
    }

    const managedTabId = managedWindows[String(window.id)];
    const stableManagedTab =
      window.type === "popup" && userTabs.find((tab) => tab.id === managedTabId);

    if (stableManagedTab) {
      for (const tab of userTabs) {
        if (tab.id !== stableManagedTab.id) {
          await moveTabToManagedWindow(tab, managedWindows);
        }
      }
      await reportSettled(window.id, stableManagedTab.id);
      continue;
    }

    if (window.type === "popup") {
      const [keptTab, ...extraTabs] = userTabs;
      await bindExistingPopup(window.id, keptTab, managedWindows);
      for (const tab of extraTabs) {
        await moveTabToManagedWindow(tab, managedWindows);
      }
      continue;
    }

    for (const tab of userTabs) {
      await moveTabToManagedWindow(tab, managedWindows);
    }
  }

  await chrome.storage.session.set({ managedWindows });
}

async function bindExistingPopup(windowId, tab, managedWindows) {
  const nonce = crypto.randomUUID();
  const marker = await chrome.tabs.create({
    windowId,
    url: markerURL(nonce),
    active: true,
  });
  await bindWindow(nonce, windowId, tab.id);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.tabs.remove(marker.id);
  managedWindows[String(windowId)] = tab.id;
  await reportSettled(windowId, tab.id);
}

async function moveTabToManagedWindow(tab, managedWindows) {
  const nonce = crypto.randomUUID();
  const popup = await chrome.windows.create({
    url: markerURL(nonce),
    type: "popup",
    focused: false,
  });
  const marker = popup.tabs?.[0];
  if (!popup.id || !marker?.id) {
    throw new Error("Chromium did not create the Aperture marker window");
  }

  await bindWindow(nonce, popup.id, tab.id);
  await chrome.tabs.move(tab.id, { windowId: popup.id, index: -1 });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.tabs.remove(marker.id);
  managedWindows[String(popup.id)] = tab.id;
  await reportSettled(popup.id, tab.id);
}

async function bindWindow(nonce, windowId, tabId) {
  const response = await nativeRequest({ type: "binding.bind", nonce, windowId, tabId });
  if (!response.ok) {
    throw new Error(response.error ?? "Aperture rejected the window binding");
  }
}

async function reportSettled(windowId, tabId) {
  const response = await nativeRequest({ type: "window.settled", windowId, tabId });
  if (!response.ok) {
    throw new Error(response.error ?? "Aperture rejected the settled window");
  }
}

async function forgetManagedWindow(windowId) {
  const stored = await chrome.storage.session.get("managedWindows");
  const managedWindows = stored.managedWindows ?? {};
  delete managedWindows[String(windowId)];
  await chrome.storage.session.set({ managedWindows });
  try {
    await nativeRequest({ type: "window.closed", windowId });
  } catch (error) {
    console.error("Aperture window close report failed", error);
  }
}

function nativeRequest(message) {
  const port = connectNative();
  nextRequestId += 1;
  const id = String(nextRequestId);
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    port.postMessage({ ...message, id });
  });
}

function connectNative() {
  if (nativePort !== null) {
    return nativePort;
  }
  nativePort = chrome.runtime.connectNative(nativeHost);
  nativePort.onMessage.addListener((message) => {
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(message.id);
    pending.resolve(message);
  });
  nativePort.onDisconnect.addListener(() => {
    const error = new Error(chrome.runtime.lastError?.message ?? "Aperture native host disconnected");
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests = new Map();
    nativePort = null;
  });
  return nativePort;
}

function markerURL(nonce) {
  return chrome.runtime.getURL(`${markerPath}?nonce=${encodeURIComponent(nonce)}`);
}

function isUserTab(tab) {
  const url = tab.url ?? tab.pendingUrl ?? "";
  return Boolean(tab.id && url && !url.startsWith(chrome.runtime.getURL(markerPath)));
}
