import { Monitor, Smartphone } from "lucide-react";
import type { PageMode } from "@aperture-browser/session-client";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { useInputState } from "../hooks/use-actions.ts";
import { useSession, useWatchedTarget } from "../session.tsx";
import { Described } from "./menu-parts.tsx";

const MODES: readonly { mode: PageMode; label: string; detail: string }[] = [
  { mode: "auto", label: "Auto", detail: "As on the device of whoever holds the tab." },
  { mode: "desktop", label: "Desktop", detail: "As a desktop's browser shows it." },
  { mode: "mobile", label: "Mobile", detail: "As a phone's browser shows it." },
];

const isMode = (value: unknown): value is PageMode => MODES.some((one) => one.mode === value);

/**
 * How the watched tab's pages are shown: as on a desktop, as on a phone, or as on what its
 * holder uses. The page loads again when that changes how it is shown.
 */
export function PageModeItem() {
  const session = useSession();
  const watched = useWatchedTarget();
  const { changes } = useInputState();
  const label = MODES.find((one) => one.mode === watched?.mode)?.label ?? "";
  const shown = watched?.mobile === true ? "mobile" : "desktop";

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        disabled={!changes || watched === undefined}
        data-workbench-page-mode={watched?.mode}
      >
        {watched?.mobile === true ? <Smartphone /> : <Monitor />}
        <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-between aperture:gap-3">
          <span data-menu-title="" className="aperture:shrink-0">
            Page mode
          </span>
          <span className="aperture:truncate aperture:text-muted-foreground">
            {watched?.mode === "auto" ? `Auto · ${shown}` : label}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="aperture:w-64">
        <DropdownMenuRadioGroup
          aria-label="How the tab's pages are shown"
          value={watched?.mode ?? ""}
          onValueChange={(value) => {
            if (isMode(value)) {
              session.setMode(value);
            }
          }}
        >
          {MODES.map(({ mode, label: name, detail }) => (
            <DropdownMenuRadioItem key={mode} value={mode} data-page-mode={mode} closeOnClick>
              <Described title={name}>{detail}</Described>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
