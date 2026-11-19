import {
  Circle,
  ClipboardPaste,
  Copy,
  Eye,
  Hand,
  Hourglass,
  Keyboard,
  Link2,
  Monitor,
  MoreVertical,
  RotateCcw,
  SunMoon,
  TextSelect,
  Undo2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { useInputState, useTabSound } from "../hooks/use-actions.ts";
import { recordingRuns } from "../hooks/use-recordings.ts";
import { copyTextHere, pasteHere } from "../notices.ts";
import {
  useLease,
  useReconnect,
  useSession,
  useSessionSnapshot,
  useWatchedTarget,
} from "../session.tsx";
import type { ApertureTheme } from "../ui-root.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchMenuSlot } from "../workbench/slot.tsx";
import { ToolbarButton, useCompactToolbar } from "./browser-toolbar.tsx";
import { MenuButton } from "./menu-parts.tsx";

const THEMES: Readonly<Record<ApertureTheme, string>> = {
  system: "As the system",
  light: "Light",
  dark: "Dark",
};

const isTheme = (value: unknown): value is ApertureTheme =>
  typeof value === "string" && value in THEMES;

/** Brings up a phone's keyboard, which comes only for a field that is focused in a tap. */
export function KeyboardAction() {
  const session = useSession();
  const { gives } = useInputState();
  return (
    <ToolbarButton
      label="Type into the session"
      className="aperture:hidden aperture:any-pointer-coarse:inline-flex"
      disabled={!gives}
      onClick={() => session.focus()}
    >
      <Keyboard />
    </ToolbarButton>
  );
}

/** The recording menu, from a button that tells when a recording runs. */
export function RecordingAction() {
  const { features, recordings } = useWorkbench();
  const compact = useCompactToolbar();
  const active = recordings.recordings.some(recordingRuns);

  if (!features.recordings || compact) {
    return null;
  }
  return (
    <DropdownMenu>
      <MenuButton
        label={active ? "Recording in progress" : "Recording"}
        variant={active ? "destructive" : "ghost"}
        data-workbench-recording=""
      >
        <Circle fill={active ? "currentColor" : "none"} />
      </MenuButton>
      <DropdownMenuContent align="end" className="aperture:w-72">
        <WorkbenchMenuSlot name="menu.recording" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How the picture comes, and the watched tab's viewport. */
export function PictureAction() {
  return (
    <DropdownMenu>
      <MenuButton label="Picture and viewport" data-workbench-picture="">
        <Monitor />
      </MenuButton>
      <DropdownMenuContent align="end" className="aperture:w-64">
        <WorkbenchMenuSlot name="menu.picture" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu with the lease, the clipboard and the rest. */
export function BrowserMenuAction() {
  return (
    <DropdownMenu>
      <MenuButton label="Browser menu" data-workbench-menu="">
        <MoreVertical />
      </MenuButton>
      <DropdownMenuContent align="end" className="aperture:w-60">
        <WorkbenchMenuSlot name="menu.browser" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The keyboard goes back to the session once the menu has closed and given focus back.
function useThenFocus() {
  const session = useSession();
  return (act: () => void) => () => {
    act();
    requestAnimationFrame(() => session.focus());
  };
}

export function CopyItem() {
  const session = useSession();
  const { features } = useWorkbench();
  const { gives } = useInputState();
  const thenFocus = useThenFocus();

  if (!features.access.clipboard.read) {
    return null;
  }
  return (
    <DropdownMenuItem disabled={!gives} onClick={thenFocus(session.copySelection)}>
      <Copy />
      Copy from the session
    </DropdownMenuItem>
  );
}

export function PasteItem() {
  const session = useSession();
  const { features } = useWorkbench();
  const { gives } = useInputState();
  const thenFocus = useThenFocus();

  if (!features.access.clipboard.write) {
    return null;
  }
  return (
    <DropdownMenuItem disabled={!gives} onClick={thenFocus(() => pasteHere(session))}>
      <ClipboardPaste />
      Paste into the session
    </DropdownMenuItem>
  );
}

export function SelectAllItem() {
  const session = useSession();
  const { gives } = useInputState();
  const thenFocus = useThenFocus();
  return (
    <DropdownMenuItem disabled={!gives} onClick={thenFocus(session.selectAll)}>
      <TextSelect />
      Select all
    </DropdownMenuItem>
  );
}

export function TypeItem() {
  const { gives } = useInputState();
  const thenFocus = useThenFocus();
  return (
    <DropdownMenuItem
      // Where a finger points, the toolbar has a button for it.
      className="aperture:any-pointer-coarse:hidden"
      disabled={!gives}
      onClick={thenFocus(() => undefined)}
    >
      <Keyboard />
      Type into the session
    </DropdownMenuItem>
  );
}

/** Mutes the watched tab for this client, or lets it be heard again. */
export function MuteItem() {
  const { features } = useWorkbench();
  const watched = useWatchedTarget();
  const sound = useTabSound(watched);

  if (!features.sound) {
    return null;
  }
  return (
    <DropdownMenuItem disabled={watched === undefined} onClick={sound.toggle}>
      {sound.muted ? <Volume2 /> : <VolumeX />}
      {sound.muted ? "Unmute the tab" : "Mute the tab"}
    </DropdownMenuItem>
  );
}

/** The recording menu inside the browser menu, where the toolbar has no room for its button. */
export function RecordingSubmenuItem() {
  const { features, recordings } = useWorkbench();
  const compact = useCompactToolbar();
  const active = recordings.recordings.some(recordingRuns);

  if (!features.recordings || !compact) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Circle
          fill={active ? "currentColor" : "none"}
          className={active ? "aperture:text-destructive" : undefined}
        />
        Recording
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="aperture:w-72">
        <WorkbenchMenuSlot name="menu.recording" />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function CopyUrlItem() {
  const session = useSession();
  const watched = useWatchedTarget();
  return (
    <DropdownMenuItem
      disabled={watched === undefined}
      onClick={() => {
        if (watched !== undefined) {
          copyTextHere(session, watched.url, "URL copied");
        }
      }}
    >
      <Link2 />
      Copy the tab's URL
    </DropdownMenuItem>
  );
}

export function AppearanceItem() {
  const { appearance } = useWorkbench();

  if (appearance === undefined) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <SunMoon />
        Appearance
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="aperture:w-44">
        <DropdownMenuRadioGroup
          aria-label="Appearance"
          value={appearance.theme}
          onValueChange={(value) => {
            if (isTheme(value)) {
              appearance.onThemeChange(value);
            }
          }}
        >
          {Object.entries(THEMES).map(([theme, label]) => (
            <DropdownMenuRadioItem key={theme} value={theme} closeOnClick={false}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function ReconnectItem() {
  const reconnect = useReconnect();

  if (reconnect === undefined) {
    return null;
  }
  return (
    <DropdownMenuItem onClick={() => reconnect()}>
      <RotateCcw />
      Reconnect
    </DropdownMenuItem>
  );
}

/** What this member may do about the lease of the watched tab. */
export function LeaseItems() {
  const { features } = useWorkbench();
  const session = useSession();
  const lease = useLease();
  const snapshot = useSessionSnapshot();
  const watches = snapshot.connection.state === "open" && snapshot.selected !== undefined;
  const holder = lease.holder?.agent ? "automation" : (lease.holder?.name ?? "someone");

  if (!features.presence) {
    return null;
  }
  switch (lease.state) {
    case "view-only": {
      return (
        <DropdownMenuItem disabled>
          <Eye />
          View only
        </DropdownMenuItem>
      );
    }
    case "free": {
      return (
        <DropdownMenuItem disabled={!watches} onClick={() => session.lease("take")}>
          <Hand />
          Take the lease
        </DropdownMenuItem>
      );
    }
    case "yours": {
      return (
        <DropdownMenuItem onClick={() => session.lease("release")}>
          <Undo2 />
          Release the lease
        </DropdownMenuItem>
      );
    }
    case "asked-of-you": {
      return (
        <>
          <DropdownMenuItem onClick={() => session.lease("allow")}>
            <Undo2 />
            Allow {lease.asker?.name ?? "them"} the lease
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => session.lease("keep")}>
            <Hand />
            Keep the lease
          </DropdownMenuItem>
        </>
      );
    }
    case "you-asked": {
      return (
        <DropdownMenuItem disabled>
          <Hourglass />
          Asked {holder} for the lease
        </DropdownMenuItem>
      );
    }
    case "theirs":
    case "theirs-asked": {
      const takes = lease.role === "admin" || lease.holder?.agent === true;
      return (
        <DropdownMenuItem
          disabled={lease.state === "theirs-asked" && !takes}
          onClick={() => session.lease("take")}
        >
          <Hand />
          {takes ? `Take the lease from ${holder}` : `Ask ${holder} for the lease`}
        </DropdownMenuItem>
      );
    }
  }
}
