import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PictureWay, Session } from "@aperture-browser/session-client";
import {
  ApertureSession,
  type ApertureTheme,
  useKeyboardInset,
} from "@aperture-browser/session-react";
import "./styles.css";

declare global {
  interface Window {
    /** The session's client, for automation and tests. None while there is no connection. */
    apertureSession: Session | undefined;
  }
}

const THEME_KEY = "aperture.workbench.theme";

const isTheme = (value: string | null): value is ApertureTheme =>
  value === "light" || value === "dark" || value === "system";

const isWay = (value: string | null): value is PictureWay =>
  value === "video" || value === "frames" || value === "tiles";

// The page is served by its session, at the session's own base: `/` by a session that runs
// on its own, `/sessions/<id>` by an executor.
const base = `${location.origin}${location.pathname.replace(/\/+$/u, "")}`;
const query = new URLSearchParams(location.search);
const token = query.get("token") ?? undefined;
const name = query.get("name") ?? undefined;
const asked = query.get("pixels");
const pixels = isWay(asked) ? asked : undefined;
// `fit=0` leaves targets the size they have, for whoever watches without changing them.
const fit = !["0", "off", "false"].includes(query.get("fit") ?? "");

function storedTheme(): ApertureTheme {
  const given = query.get("theme");
  if (isTheme(given)) {
    return given;
  }
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    // Storage that is unavailable leaves the system's choice.
    return "system";
  }
}

function Workbench() {
  const [theme, setTheme] = useState(storedTheme);
  useKeyboardInset();

  const changeTheme = useCallback((next: ApertureTheme) => {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Kept for this page only.
    }
  }, []);

  const expose = useCallback((session: Session | null) => {
    window.apertureSession = session ?? undefined;
  }, []);

  return (
    <ApertureSession
      url={base}
      token={token}
      name={name}
      pixels={pixels}
      fit={fit}
      theme={theme}
      onThemeChange={changeTheme}
      onSession={expose}
    />
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<Workbench />);
}
