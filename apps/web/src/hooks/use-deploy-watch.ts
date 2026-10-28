import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const CHECK_INTERVAL_MS = 5 * 60_000;
const ENTRY_SCRIPT = /<script[^>]*type="module"[^>]*src="([^"]+)"/;

const loadedEntry = () =>
  document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ??
  null;

const deployedEntry = async () => {
  const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
  if (!response.ok) {
    return null;
  }
  return ENTRY_SCRIPT.exec(await response.text())?.[1] ?? null;
};

// A tab keeps the build it loaded, while the server answers with whatever was deployed last. The
// entry script's hashed name identifies a build: once the served page names another one, the next
// navigation becomes a full page load, and a toast offers to reload right away.
export function useDeployWatch() {
  const router = useRouter();
  const stale = useRef(false);

  useEffect(() => {
    const current = loadedEntry();
    // The dev server serves unhashed modules and updates them itself.
    if (!import.meta.env.PROD || current === null) {
      return;
    }

    const check = async () => {
      if (stale.current || document.visibilityState !== "visible") {
        return;
      }
      const deployed = await deployedEntry().catch(() => null);
      if (deployed === null || deployed === current) {
        return;
      }
      stale.current = true;
      toast.info("A new version of Aperture is available", {
        duration: Infinity,
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
    };

    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribe = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
      if (stale.current) {
        window.location.assign(toLocation.href);
      }
    });
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [router]);
}
