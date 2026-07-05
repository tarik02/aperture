let stream = null;
let state = {
  status: "idle",
  targetTabId: null,
  videoTrackReadyState: null,
  width: null,
  height: null,
  lastError: null,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      state = {
        ...state,
        status: "error",
        lastError: error instanceof Error ? error.message : "offscreen capture failed",
      };
      sendState();
      sendResponse(snapshot());
    });
  return true;
});

async function handleMessage(message) {
  if (message?.type === "capture-proof.consume-stream-id") {
    await startStream(message.streamId, message.targetTabId);
    return snapshot();
  }
  if (message?.type === "capture-proof.stop-offscreen") {
    stopStream(message.reason);
    return snapshot();
  }
  return snapshot();
}

async function startStream(streamId, targetTabId) {
  stopStream("restarting offscreen capture");
  state = {
    status: "starting",
    targetTabId,
    videoTrackReadyState: null,
    width: null,
    height: null,
    lastError: null,
  };
  sendState();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  const [track] = stream.getVideoTracks();
  if (!track) {
    throw new Error("offscreen document received no video track");
  }

  track.addEventListener("ended", () => {
    state = { ...state, status: "ended", videoTrackReadyState: track.readyState };
    sendState();
  });

  const preview = document.querySelector("#preview");
  preview.srcObject = stream;
  await preview.play();

  const settings = track.getSettings();
  state = {
    status: "live",
    targetTabId,
    videoTrackReadyState: track.readyState,
    width: settings.width ?? null,
    height: settings.height ?? null,
    lastError: null,
  };
  sendState();
}

function stopStream(reason) {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
  stream = null;
  state = {
    status: "idle",
    targetTabId: null,
    videoTrackReadyState: null,
    width: null,
    height: null,
    lastError: reason ?? null,
  };
  sendState();
}

function sendState() {
  void chrome.runtime.sendMessage({
    type: "capture-proof.offscreen-state",
    state: snapshot(),
  });
}

function snapshot() {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
  };
}
