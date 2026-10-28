import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const PRELOAD_RELOAD_KEY = "aperture:preload-error-reload-at";
const PRELOAD_RELOAD_COOLDOWN_MS = 30_000;

// A deploy replaces hashed chunks, so tabs opened before it fail to load lazy routes and
// components. Reload once to pick up the new build; the cooldown avoids a reload loop when
// the asset is genuinely missing.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    const lastReloadAt = Number(window.sessionStorage.getItem(PRELOAD_RELOAD_KEY) ?? 0);
    if (Date.now() - lastReloadAt < PRELOAD_RELOAD_COOLDOWN_MS) {
      return;
    }
    event.preventDefault();
    window.sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
    window.location.reload();
  });
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
