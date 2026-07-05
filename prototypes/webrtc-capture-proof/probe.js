const statusElement = document.querySelector("#status");
const params = new URLSearchParams(window.location.search);

document.querySelector("#start").addEventListener("click", () => {
  void startCapture();
});
document.querySelector("#stop").addEventListener("click", () => {
  void send({ type: "capture-proof.stop" });
});
document.querySelector("#refresh").addEventListener("click", () => {
  void send({ type: "capture-proof.status" });
});

if (params.get("autostart") === "1") {
  void startCapture();
} else {
  void send({ type: "capture-proof.status" });
}

function startCapture() {
  void send({
    type: "capture-proof.start",
    expectedUrl: params.get("expectedUrl") ?? "",
  });
}

async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    statusElement.textContent = JSON.stringify(response, null, 2);
  } catch (error) {
    statusElement.textContent = JSON.stringify(
      {
        status: "error",
        message: error instanceof Error ? error.message : "probe failed",
      },
      null,
      2,
    );
  }
}
