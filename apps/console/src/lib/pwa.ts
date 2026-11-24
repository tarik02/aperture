/**
 * Registers the worker that makes the console installable. Only what was built has one: the
 * worker keeps files by their hashed names, which a development server does not give them.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator) || !window.isSecureContext) {
    return;
  }
  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("service worker registration failed", error);
    });
  };
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}
