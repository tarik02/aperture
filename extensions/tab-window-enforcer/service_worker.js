const nativeHost = "me.tarik02.aperture.tab_window_enforcer";
const markerURL = chrome.runtime.getURL("marker.html");

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
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const liveWindowIds = new Set(windows.map((window) => String(window.id)));

  for (const windowId of Object.keys(managedWindows)) {
    if (!liveWindowIds.has(windowId)) {
      delete managedWindows[windowId];
    }
  }

  for (const window of windows) {
    const tabs = window.tabs ?? [];
    const userTabs = tabs.filter(isUserTab);
    if (userTabs.length === 0) {
      if (tabs.some(isMarkerTab)) {
        await chrome.windows.remove(window.id).catch(() => {});
      }
      continue;
    }

    const managedTabId = managedWindows[String(window.id)];
    const stableManagedTab = userTabs.find((tab) => tab.id === managedTabId);

    if (stableManagedTab) {
      for (const tab of userTabs) {
        if (tab.id !== stableManagedTab.id) {
          await moveTabToManagedWindow(tab, managedWindows);
        }
      }
      await Promise.all(tabs.filter(isMarkerTab).map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
      await reportSettled(window.id, stableManagedTab.id);
      continue;
    }

    for (const tab of userTabs) {
      await moveTabToManagedWindow(tab, managedWindows);
    }
  }

  await chrome.storage.session.set({ managedWindows });
}

async function moveTabToManagedWindow(tab, managedWindows) {
  const nonce = crypto.randomUUID();
  let prepared = false;
  let bound = false;
  let moved = false;
  let managedWindowId = null;

  try {
    await prepareBinding(nonce);
    prepared = true;
    const managedWindow = await chrome.windows.create({
      url: markerURL,
      type: "normal",
      focused: false,
    });
    const marker = managedWindow.tabs?.[0];
    if (!managedWindow.id || !marker?.id) {
      throw new Error("Chromium did not create the Aperture marker window");
    }
    managedWindowId = managedWindow.id;
    try {
      await bindWindow(nonce, managedWindow.id, tab.id);
      bound = true;
      await chrome.tabs.move(tab.id, { windowId: managedWindow.id, index: -1 });
      moved = true;
      await chrome.tabs.update(tab.id, { active: true });
    } finally {
      await chrome.tabs.remove(marker.id).catch(() => {});
    }
    managedWindows[String(managedWindow.id)] = tab.id;
    await reportSettled(managedWindow.id, tab.id);
  } catch (error) {
    if (bound && managedWindowId !== null && !moved) {
      await nativeRequest({ type: "window.closed", windowId: managedWindowId }).catch(() => {});
    }
    if (managedWindowId !== null && !moved) {
      await chrome.windows.remove(managedWindowId).catch(() => {});
    }
    throw error;
  } finally {
    if (prepared && !bound) {
      await cancelBinding(nonce).catch(() => {});
    }
  }
}

async function prepareBinding(nonce) {
  const response = await nativeRequest({ type: "binding.prepare", nonce });
  if (!response.ok) {
    throw new Error(response.error ?? "Aperture rejected the window binding preparation");
  }
}

async function cancelBinding(nonce) {
  const response = await nativeRequest({ type: "binding.cancel", nonce });
  if (!response.ok) {
    throw new Error(response.error ?? "Aperture rejected the window binding cancellation");
  }
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

function isUserTab(tab) {
  const url = tab.url ?? tab.pendingUrl ?? "";
  return Boolean(tab.id && url && !url.startsWith(markerURL));
}

function isMarkerTab(tab) {
  const url = tab.url ?? tab.pendingUrl ?? "";
  return Boolean(tab.id && url.startsWith(markerURL));
}
