// The session's runner, through the native messaging host. A request is answered; what is
// told is not.
const HOST = "me.tarik02.aperture.session";

let host = null;
let requests = 0;
const pending = new Map();
const connected = () => {
  if (host !== null) return host;
  host = chrome.runtime.connectNative(HOST);
  host.onMessage.addListener((answer) => {
    const waiting = pending.get(answer?.id);
    if (!waiting) return;
    pending.delete(answer.id);
    if (answer.ok) waiting.resolve();
    else waiting.reject(new Error(answer.error ?? "the session refused"));
  });
  host.onDisconnect.addListener(() => {
    const error = new Error(chrome.runtime.lastError?.message ?? "the session's host disconnected");
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    host = null;
  });
  return host;
};
const request = (message) =>
  new Promise((resolve, reject) => {
    const id = String(++requests);
    pending.set(id, { resolve, reject });
    try {
      connected().postMessage({ ...message, id });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
const tell = (message) => {
  try {
    connected().postMessage(message);
  } catch {
    // Said again by whoever still has it to say, once the host is back.
  }
};
const quietly = (attempt) => attempt.catch(() => {});

// A window per page. Exactly one page's tab is in each window the session knows, which it
// shows as a target of its own: other tabs move to windows of their own, and so does the
// tab of a popup a page opened, which keeps its opener.
const MARKER = chrome.runtime.getURL("marker.html");
const address = (tab) => tab.url ?? tab.pendingUrl ?? "";
// The placeholder a window is created with.
const isMarker = (tab) => Boolean(tab.id && address(tab).startsWith(MARKER));
// A tab a page opened has no address until its first response arrives, and still counts:
// left in its opener's window, it would keep that window from settling while it loads.
const isPage = (tab) => Boolean(tab.id) && !isMarker(tab);

// Window to the one tab it holds. In session storage, which outlives the worker.
const known = async () => {
  const { managedWindows } = await chrome.storage.session.get("managedWindows");
  return managedWindows && typeof managedWindows === "object" ? { ...managedWindows } : {};
};
const keep = (windows) => chrome.storage.session.set({ managedWindows: windows });

// Moves a tab into a new window. The window opens on the marker page, so that the session
// finds its surface by the nonce before the tab arrives. Each step undoes those before it
// when a later one fails.
const give = async (tab, windows) => {
  const nonce = crypto.randomUUID();
  const cancel = () => quietly(request({ type: "binding.cancel", nonce }));
  await request({ type: "binding.prepare", nonce });
  let made;
  try {
    made = await chrome.windows.create({ url: MARKER, type: "normal", focused: false });
    if (made?.id === undefined || made.tabs?.[0]?.id === undefined) throw new Error("no window was made for the page");
  } catch (error) {
    await cancel();
    throw error;
  }
  const window = made.id;
  const dropMarker = () => quietly(chrome.tabs.remove(made.tabs[0].id));
  const dropWindow = () => quietly(chrome.windows.remove(window));
  try {
    await request({ type: "binding.bind", nonce, windowId: window, tabId: tab.id });
  } catch (error) {
    await Promise.all([dropMarker(), dropWindow(), cancel()]);
    throw error;
  }
  try {
    await chrome.tabs.move(tab.id, { windowId: window, index: -1 });
  } catch (error) {
    await Promise.all([dropMarker(), quietly(request({ type: "window.closed", windowId: window })), dropWindow()]);
    throw error;
  }
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } finally {
    await dropMarker();
  }
  windows[String(window)] = tab.id;
  await request({ type: "window.settled", windowId: window, tabId: tab.id });
};

const settle = async () => {
  const windows = await known();
  const open = await chrome.windows.getAll({ populate: true, windowTypes: ["normal", "popup"] });
  const here = new Set(open.map((window) => String(window.id)));
  for (const window of Object.keys(windows)) {
    if (!here.has(window)) delete windows[window];
  }
  for (const window of open) {
    if (window.id === undefined) continue;
    const tabs = window.tabs ?? [];
    const pages = tabs.filter(isPage);
    if (pages.length === 0) {
      if (tabs.some(isMarker)) await quietly(chrome.windows.remove(window.id));
      continue;
    }
    const own = pages.find((tab) => tab.id === windows[String(window.id)]);
    for (const tab of pages) {
      if (tab !== own) await give(tab, windows);
    }
    if (!own) continue;
    await Promise.all(tabs.filter(isMarker).map((tab) => quietly(chrome.tabs.remove(tab.id))));
    await request({ type: "window.settled", windowId: window.id, tabId: own.id });
  }
  await keep(windows);
};

// Bursts of tab events settle into one pass, and passes never overlap. A failed pass runs
// again after the next quiet moment.
let quiet = null;
let settling = false;
let again = false;
const pass = async () => {
  if (settling) {
    again = true;
    return;
  }
  settling = true;
  try {
    await settle();
  } catch (error) {
    console.error("failed to give every page its window", error);
    again = true;
  }
  settling = false;
  if (again) {
    again = false;
    soon();
  }
};
const soon = () => {
  clearTimeout(quiet);
  quiet = setTimeout(pass, 25);
};

const forget = async (window) => {
  const windows = await known();
  delete windows[String(window)];
  await keep(windows);
  await request({ type: "window.closed", windowId: window });
};

// The sound of each tab, apart from the others. The page that holds the taps: a worker
// has no media of its own.
let holder = null;
const held = () => {
  holder ??= chrome.offscreen
    .hasDocument()
    .then((there) => there || chrome.offscreen.createDocument({ url: "taps.html", reasons: ["USER_MEDIA"], justification: "the sound of each tab" }));
  return holder;
};

// What the session's runner wrote next to this script when it started the browser.
const options = fetch(chrome.runtime.getURL("options.json")).then((answer) => answer.json()).catch(() => ({}));

// The tabs that are tapped or about to be.
const tapped = new Set();
const tap = async (tab) => {
  if (!(await options).sound) return;
  if (tab.id === undefined || isMarker(tab) || tapped.has(tab.id)) return;
  tapped.add(tab.id);
  try {
    await held();
    const stream = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const answer = await chrome.runtime.sendMessage({ tap: stream, tab: tab.id });
    if (!answer?.tapped) throw new Error(answer?.error ?? "the tap did not start");
  } catch (error) {
    tapped.delete(tab.id);
    // A tab that is gone already was not for hearing.
    if (await chrome.tabs.get(tab.id).catch(() => null)) {
      tell({ type: "sound.refused", tabId: tab.id, error: String(error?.message ?? error) });
    }
  }
};

// Chromium only delivers the events that woke the worker to listeners added while the
// script first runs, so these are added here, at once.
chrome.runtime.onConnect.addListener((taps) => {
  taps.onMessage.addListener((message) => {
    if (message.type === "sound.untapped") tapped.delete(message.tabId);
    tell(message);
  });
});
chrome.runtime.onInstalled.addListener(soon);
chrome.runtime.onStartup.addListener(soon);
chrome.tabs.onCreated.addListener((tab) => {
  soon();
  tap(tab);
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  soon();
  if (change.url !== undefined || change.status === "complete") tap(tab);
});
chrome.tabs.onReplaced.addListener((added) => chrome.tabs.get(added).then(tap, () => {}));
chrome.tabs.onAttached.addListener(soon);
chrome.tabs.onDetached.addListener(soon);
chrome.tabs.onRemoved.addListener(soon);
chrome.windows.onCreated.addListener(soon);
chrome.windows.onRemoved.addListener((window) => {
  forget(window).catch((error) => console.error("failed to say a window closed", error));
  soon();
});
soon();
chrome.tabs.query({}).then((tabs) => tabs.forEach(tap));
