const statusElement = document.querySelector("#status");
const previewElement = document.querySelector("#preview");
const params = new URLSearchParams(window.location.search);
let stream = null;
let state = {
  status: "idle",
  targetTabId: null,
  sourceMode: null,
  streamIdIssuedAt: null,
  desktopCaptureOptions: null,
  videoTrackReadyState: null,
  width: null,
  height: null,
  lastError: null,
};

document.querySelector("#start").addEventListener("click", () => {
  void show(startCapture());
});
document.querySelector("#stop").addEventListener("click", () => {
  void show(sendMessage({ type: "capture-proof.stop" }));
});
document.querySelector("#refresh").addEventListener("click", () => {
  void show(sendMessage({ type: "capture-proof.status" }));
});

if (params.get("autostart") === "1") {
  void show(startCapture());
} else {
  void show(sendMessage({ type: "capture-proof.status" }));
}

window.captureProofStart = startCapture;
window.captureProofStatus = () => stateSnapshot();
window.captureProofStop = () => stopCapture("stopped by probe");

async function startCapture(overrides = {}) {
  const sourceMode = overrides.sourceMode ?? params.get("sourceMode") ?? "tab";
  const expectedUrl = overrides.expectedUrl ?? params.get("expectedUrl") ?? "";
  stopCapture("restarting capture");
  const prepared = await sendMessage({
    type: "capture-proof.prepare-desktop-capture",
    expectedUrl,
    sourceMode,
  });
  if (prepared.status === "error") {
    return prepared;
  }

  state = {
    status: "requesting-desktop-stream-id",
    targetTabId: prepared.targetTabId,
    sourceMode,
    streamIdIssuedAt: null,
    desktopCaptureOptions: null,
    videoTrackReadyState: null,
    width: null,
    height: null,
    lastError: null,
  };
  void publishState();

  const { streamId, options } = await chooseDesktopMedia(sourceMode);
  state = {
    ...state,
    status: "starting",
    streamIdIssuedAt: new Date().toISOString(),
    desktopCaptureOptions: options,
  };
  void publishState();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
      },
    },
  });
  const [track] = stream.getVideoTracks();
  if (!track) {
    throw new Error("probe received no video track");
  }
  track.addEventListener("ended", () => {
    state = { ...state, status: "ended", videoTrackReadyState: track.readyState };
    void publishState();
  });

  previewElement.srcObject = stream;
  await previewElement.play();

  const settings = track.getSettings();
  state = {
    ...state,
    status: "capturing",
    videoTrackReadyState: track.readyState,
    width: settings.width ?? null,
    height: settings.height ?? null,
    lastError: null,
  };
  void publishState();
  return stateSnapshot();
}

function chooseDesktopMedia(sourceMode) {
  return new Promise((resolve, reject) => {
    let requestId = null;
    const timeout = setTimeout(() => {
      if (requestId !== null) {
        chrome.desktopCapture.cancelChooseDesktopMedia(requestId);
      }
      reject(new Error(`desktopCapture picker did not auto-select ${sourceMode} source`));
    }, 5000);

    requestId = chrome.desktopCapture.chooseDesktopMedia([sourceMode], (streamId, options) => {
      clearTimeout(timeout);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!streamId) {
        reject(new Error("desktopCapture returned no stream id"));
        return;
      }
      resolve({ streamId, options });
    });
  });
}

async function show(promise) {
  try {
    statusElement.textContent = JSON.stringify(await promise, null, 2);
  } catch (error) {
    statusElement.textContent = JSON.stringify(errorResponse(error), null, 2);
  }
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return errorResponse(error);
  }
}

function stopCapture(reason) {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
  stream = null;
  previewElement.srcObject = null;
  state = {
    status: "idle",
    targetTabId: null,
    sourceMode: null,
    streamIdIssuedAt: null,
    desktopCaptureOptions: null,
    videoTrackReadyState: null,
    width: null,
    height: null,
    lastError: reason,
  };
  void publishState();
  return stateSnapshot();
}

async function publishState() {
  await sendMessage({
    type: "capture-proof.producer-state",
    state: stateSnapshot(),
  });
}

function stateSnapshot() {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
  };
}

function errorResponse(error) {
  return {
    status: "error",
    message: error instanceof Error ? error.message : "probe failed",
  };
}
