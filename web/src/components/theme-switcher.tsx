import { ChevronsUpDown, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { ComponentType, SVGProps } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";

type ThemeMode = "system" | "light" | "dark";

type ThemeOption = {
  value: ThemeMode;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const THEME_OPTIONS: ThemeOption[] = [
  { value: "system", label: "Auto", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const activeTheme = isThemeMode(theme) ? theme : "system";
  const activeOption =
    THEME_OPTIONS.find((option) => option.value === activeTheme) ?? THEME_OPTIONS[0];
  const ActiveIcon = activeOption.icon;

  function handleThemeChange(value: string) {
    if (!isThemeMode(value) || value === activeTheme) {
      return;
    }

    const applyTheme = () => {
      applyThemeClass(value);
      setTheme(value);
    };

    if (!canStartViewTransition(document)) {
      applyTheme();
      return;
    }

    document.startViewTransition(applyTheme);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start group-data-[collapsible=icon]:gap-0"
            aria-label="Theme"
            title={`Theme: ${activeOption.label}`}
          />
        }
      >
        <ActiveIcon data-icon="inline-start" />
        <span data-sidebar-collapse-label className="min-w-0 flex-1 truncate text-left">
          {activeOption.label}
        </span>
        <ChevronsUpDown data-icon="inline-end" data-sidebar-collapse-label />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-36">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={activeTheme} onValueChange={handleThemeChange}>
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isThemeMode(value: string | undefined): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function resolveThemeClass(theme: ThemeMode) {
  if (theme !== "system") {
    return theme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeClass(theme: ThemeMode) {
  const resolvedTheme = resolveThemeClass(theme);
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolvedTheme);
  document.documentElement.style.colorScheme = resolvedTheme;
}

type ViewTransitionDocument = Document & {
  startViewTransition: (callback: () => void) => void;
};

function canStartViewTransition(document: Document): document is ViewTransitionDocument {
  return "startViewTransition" in document && typeof document.startViewTransition === "function";
}
