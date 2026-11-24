const SHELL = "aperture-shell";
const ASSETS = "aperture-assets";
const SHELL_KEY = "/index.html";

// What the control plane and the nodes answer themselves is never the worker's to keep
// or to answer for: it goes to the network as if there were no worker.
const LIVE = ["/api/", "/n/", "/mcp/", "/oauth/", "/.well-known/"];
const live = (pathname) =>
  pathname === "/mcp" || LIVE.some((prefix) => pathname.startsWith(prefix));

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // A browser that can be told so does not even wake the worker for them.
  try {
    const routed = event.addRoutes?.(
      [...LIVE.map((prefix) => `${prefix}*`), "/mcp"].map((pathname) => ({
        condition: { urlPattern: { pathname } },
        source: "network",
      })),
    );
    event.waitUntil(Promise.resolve(routed).catch(() => undefined));
  } catch {
    // The fetch handler below leaves them alone as well.
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const isPage = (response) =>
  response.ok && (response.headers.get("content-type") ?? "").startsWith("text/html");

/**
 * Keeps the page that was just served for a time without a network. A page that differs from
 * the one kept is another build, whose assets have other names: the old ones are dropped.
 */
async function keepShell(response) {
  const shell = await caches.open(SHELL);
  const kept = await shell.match(SHELL_KEY);
  const [before, now] = await Promise.all([kept?.text(), response.clone().text()]);
  if (before === now) {
    return;
  }
  if (before !== undefined) {
    await caches.delete(ASSETS);
  }
  await shell.put(SHELL_KEY, response);
}

async function page(event) {
  let response;
  try {
    response = await fetch(event.request);
  } catch (error) {
    const kept = await (await caches.open(SHELL)).match(SHELL_KEY);
    if (kept === undefined) {
      throw error;
    }
    return kept;
  }
  if (isPage(response)) {
    // Before the page is answered with: what it asks for next is kept after the old is gone.
    await keepShell(response.clone()).catch(() => undefined);
  }
  return response;
}

async function asset(event) {
  const assets = await caches.open(ASSETS);
  const kept = await assets.match(event.request);
  if (kept !== undefined) {
    return kept;
  }
  const response = await fetch(event.request);
  // A name with a hash in it is one content for good; a page answered in its place is not it.
  if (response.ok && !isPage(response)) {
    event.waitUntil(assets.put(event.request, response.clone()));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || live(url.pathname)) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(page(event));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(asset(event));
  }
});
