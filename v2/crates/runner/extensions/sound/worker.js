const HOST = "me.tarik02.aperture.sound";

let host = null;
const toHost = (message) => {
  if (host === null) {
    host = chrome.runtime.connectNative(HOST);
    host.onDisconnect.addListener(() => {
      host = null;
    });
  }
  host.postMessage(message);
};

// The page that holds the taps: a worker has no media of its own.
let holder = null;
const held = () => {
  holder ??= chrome.offscreen
    .hasDocument()
    .then((there) => there || chrome.offscreen.createDocument({ url: "taps.html", reasons: ["USER_MEDIA"], justification: "the sound of each tab" }));
  return holder;
};

// The tabs that are tapped or about to be.
const tapped = new Set();
const tap = async (tab) => {
  if (tapped.has(tab)) return;
  tapped.add(tab);
  try {
    await held();
    // Refused for the browser's own pages; the tab is tried again when it goes elsewhere.
    const stream = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab });
    const answer = await chrome.runtime.sendMessage({ tap: stream, tab });
    if (!answer?.tapped) throw new Error(answer?.error ?? "the tap did not start");
  } catch (error) {
    tapped.delete(tab);
    toHost({ type: "sound.refused", tabId: tab, error: String(error?.message ?? error) });
  }
};

chrome.runtime.onConnect.addListener((taps) => {
  taps.onMessage.addListener((message) => {
    if (message.type === "sound.untapped") tapped.delete(message.tabId);
    toHost(message);
  });
});
chrome.tabs.onCreated.addListener((tab) => tap(tab.id));
chrome.tabs.onUpdated.addListener((tab, change) => {
  if (change.url !== undefined || change.status === "complete") tap(tab);
});
chrome.tabs.onReplaced.addListener((added) => tap(added));
chrome.tabs.query({}).then((tabs) => tabs.forEach((tab) => tap(tab.id)));
