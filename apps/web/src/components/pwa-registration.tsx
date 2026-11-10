import * as Effect from "effect/Effect";
import { useFork } from "@aperture-browser/session-react";

const pageLoaded: Effect.Effect<void> = Effect.callback((resume) => {
  if (document.readyState === "complete") {
    resume(Effect.void);
    return;
  }
  const load = () => resume(Effect.void);
  window.addEventListener("load", load, { once: true });
  return Effect.sync(() => window.removeEventListener("load", load));
});

const registerServiceWorker = pageLoaded.pipe(
  Effect.andThen(
    Effect.tryPromise(() => navigator.serviceWorker.register("/sw.js", { scope: "/" })),
  ),
  Effect.catch((error) => Effect.logWarning("service worker registration failed", error)),
);

export function PwaRegistration() {
  useFork(
    () =>
      "serviceWorker" in navigator && window.isSecureContext ? registerServiceWorker : undefined,
    [],
  );

  return null;
}
