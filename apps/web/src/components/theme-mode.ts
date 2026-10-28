import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";

export type ThemeMode = "system" | "light" | "dark";

export const themeOptions: ReadonlyArray<{ value: ThemeMode; label: string; icon: LucideIcon }> = [
  { value: "system", label: "Auto", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** The chosen theme, and a setter that cross-fades into the new one where supported. */
export function useThemeMode() {
  const { theme, setTheme } = useTheme();
  const mode: ThemeMode = isThemeMode(theme) ? theme : "system";

  function changeMode(value: string) {
    if (!isThemeMode(value) || value === mode) {
      return;
    }
    const apply = () => {
      applyThemeClass(value);
      setTheme(value);
    };
    if (canStartViewTransition(document)) {
      document.startViewTransition(apply);
    } else {
      apply();
    }
  }

  return { mode, changeMode };
}

function isThemeMode(value: string | undefined): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

// Applied before next-themes re-renders, so the view transition captures the new colors.
function applyThemeClass(theme: ThemeMode) {
  const resolved =
    theme !== "system"
      ? theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.classList.toggle("aperture-dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
}

type ViewTransitionDocument = Document & {
  startViewTransition: (callback: () => void) => void;
};

function canStartViewTransition(document: Document): document is ViewTransitionDocument {
  return "startViewTransition" in document && typeof document.startViewTransition === "function";
}
