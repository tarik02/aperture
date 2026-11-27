import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const CHECK_INTERVAL_MS = 5 * 60_000;
const ENTRY_SCRIPT = /<script[^>]*type="module"[^>]*src="([^"]+)"/u;

// A built page's scripts are under /assets/; a development server's are not.
const built = () => document.querySelector('script[type="module"][src^="/assets/"]') !== null;

// Whether the window runs the build that names this entry. Not the first module script there
// is: an extension may put its own before it, which is then taken for another build.
const loaded = (entry: string) =>
  [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].some(
    (script) => script.getAttribute("src") === entry,
  );

const deployedEntry = async () => {
  const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
  if (!response.ok) {
    return null;
  }
  return ENTRY_SCRIPT.exec(await response.text())?.[1] ?? null;
};

/**
 * A window keeps the build it loaded, while the server answers with whatever was deployed
 * last. The entry script's hashed name tells one build from another: once the page that is
 * served names another, a toast offers to reload, and the next navigation loads the page anew.
 */
export function useDeployWatch() {
  const router = useRouter();
  const stale = useRef(false);

  useEffect(() => {
    // A development server serves modules without hashes and replaces them itself.
    if (!import.meta.env.PROD || !built()) {
      return undefined;
    }

    const check = async () => {
      if (stale.current || document.visibilityState !== "visible") {
        return;
      }
      const deployed = await deployedEntry().catch(() => null);
      if (deployed === null || loaded(deployed) || stale.current) {
        return;
      }
      stale.current = true;
      toast.info("A new version of Aperture is available", {
        id: "deploy-watch",
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
