let state = {
  status: "idle",
  targetTabId: null,
  streamIdIssuedAt: null,
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
  if (message?.type === "capture-proof.start") {
    return startCapture(message);
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

async function startCapture(message) {
  await ensureOffscreenDocument();
  const targetTab = await activePageTab(message.expectedUrl);
  await stopCapture("restarting capture");

  state = {
    status: "requesting-stream-id",
    targetTabId: targetTab.id,
    streamIdIssuedAt: null,
    offscreen: null,
    lastError: null,
  };

  const streamId = await getMediaStreamId(targetTab.id);
  state = {
    ...state,
    status: "starting-offscreen",
    streamIdIssuedAt: new Date().toISOString(),
  };

  const offscreenState = await chrome.runtime.sendMessage({
    type: "capture-proof.consume-stream-id",
    streamId,
    targetTabId: targetTab.id,
  });
  state = { ...state, status: "capturing", offscreen: offscreenState };
  return snapshot();
}

async function stopCapture(reason) {
  await chrome.runtime.sendMessage({ type: "capture-proof.stop-offscreen", reason }).catch(() => undefined);
  state = {
    status: "idle",
    targetTabId: null,
    streamIdIssuedAt: null,
    offscreen: null,
    lastError: reason,
  };
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

function getMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!streamId) {
        reject(new Error("tabCapture returned no stream id"));
        return;
      }
      resolve(streamId);
    });
  });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  if (contexts.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture proof needs getUserMedia to consume a tabCapture stream id.",
  });
}

function snapshot() {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
  };
}
