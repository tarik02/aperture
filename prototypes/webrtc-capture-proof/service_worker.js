let state = {
  status: "idle",
  targetTabId: null,
  sourceMode: null,
  streamIdIssuedAt: null,
  desktopCaptureOptions: null,
  offscreen: null,
  lastError: null,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      state = {
        ...state,
        status: "error",
        lastError: error instanceof Error ? error.message : "capture proof failed",
      };
      sendResponse(snapshot());
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.targetTabId === tabId) {
    void stopCapture("target tab closed");
  }
});

async function handleMessage(message) {
  if (message?.type === "capture-proof.prepare-desktop-capture") {
    return prepareDesktopCapture(message);
  }
  if (message?.type === "capture-proof.producer-state") {
    state = { ...message.state };
    return snapshot();
  }
  if (message?.type === "capture-proof.stop") {
    await stopCapture("stopped by probe");
    return snapshot();
  }
  if (message?.type === "capture-proof.offscreen-state") {
    state = { ...state, offscreen: message.state };
    return snapshot();
  }
  return snapshot();
}

async function prepareDesktopCapture(message) {
  const targetTab = await activePageTab(message.expectedUrl);
  const sourceMode = captureSourceMode(message.sourceMode);
  await stopCapture("restarting capture");

  state = {
    status: "requesting-desktop-stream-id",
    targetTabId: targetTab.id,
    sourceMode,
    streamIdIssuedAt: null,
    desktopCaptureOptions: null,
    offscreen: null,
    lastError: null,
  };
  return snapshot();
}

async function stopCapture(reason) {
  state = {
    status: "idle",
    targetTabId: null,
    sourceMode: null,
    streamIdIssuedAt: null,
    desktopCaptureOptions: null,
    offscreen: null,
    lastError: reason,
  };
}

function captureSourceMode(sourceMode) {
  if (sourceMode === "tab" || sourceMode === "window") {
    return sourceMode;
  }
  throw new Error(`unsupported desktop capture source mode: ${sourceMode}`);
}

async function activePageTab(expectedUrl) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    throw new Error("no active tab found");
  }
  if (tab.url.startsWith("chrome-extension://")) {
    throw new Error("active tab is the probe; open the probe in the background after CDP target activation");
  }
  if (typeof expectedUrl === "string" && expectedUrl !== "" && tab.url !== expectedUrl) {
    throw new Error(`active tab url mismatch: got ${tab.url}, want ${expectedUrl}`);
  }
  return tab;
}

function snapshot() {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
  };
}
