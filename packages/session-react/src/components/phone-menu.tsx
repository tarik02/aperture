import { createContext, useContext, type RefObject } from "react";
import {
  ArrowRight,
  Circle,
  ClipboardList,
  ChevronsDownUp,
  Eye,
  FolderOpen,
  Keyboard,
  Link2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { cn } from "@aperture-browser/ui/utils";
import { useInputState } from "../hooks/use-actions.ts";
import { recordingRuns } from "../hooks/use-recordings.ts";
import { copyTextHere } from "../notices.ts";
import { useSession, useSessionSnapshot, useWatchedTarget } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchMenuSlot } from "../workbench/slot.tsx";
import { Described } from "./menu-parts.tsx";
import type { useSessionFiles } from "./session-files.tsx";
import {
  AppearanceItem,
  CopyItem,
  MuteItem,
  PasteItem,
  SelectAllItem,
} from "./toolbar-actions.tsx";

/** What the phone's menu and what is contributed to it share with the bar it is opened from. */
export interface PhoneMenuState {
  /** Where the keyboard goes once the menu has closed, where an entry said so. */
  readonly typed: RefObject<HTMLElement | null>;
  /** Puts the bar away, as scrolling down the page does. */
  readonly hideBar: () => void;
  readonly files: ReturnType<typeof useSessionFiles>;
  /** Whether the bar is the slim one where the phone is held upright. */
  readonly slim: boolean;
  readonly setSlim: (slim: boolean) => void;
}

export const PhoneMenuContext = createContext<PhoneMenuState | null>(null);

function usePhoneMenu(): PhoneMenuState {
  const value = useContext(PhoneMenuContext);
  if (value === null) {
    throw new Error("A phone menu's entry is used outside the phone's workbench");
  }
  return value;
}

/** One of the row of things done most, above the menu's rows: its icon over its name. */
const QUICK =
  "aperture:min-h-16 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:justify-center aperture:gap-1.5 aperture:rounded-xl aperture:bg-muted/60 aperture:px-1 aperture:text-xs";

/**
 * The phone's menu: a sheet at the window's foot with what is done most as a row of
 * buttons, then what is contributed to `menu.phone`, whose submenus are pages of the sheet.
 */
export function PhoneMenu({
  open,
  onOpenChange,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string | undefined;
}) {
  const session = useSession();
  const { features, recordings } = useWorkbench();
  const { changes } = useInputState();
  const watched = useWatchedTarget();
  const { typed, files } = usePhoneMenu();
  const goes = changes && watched !== undefined;
  const recording = recordings.recordings.some(recordingRuns);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          typed.current = null;
        }
        onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            aria-label="Menu"
            data-workbench-menu=""
            className={cn("aperture:relative", className)}
          />
        }
      >
        <MoreHorizontal />
        {files.request !== undefined || recording ? (
          <span
            className={cn(
              "aperture:absolute aperture:top-1.5 aperture:right-1.5 aperture:size-2 aperture:rounded-full aperture:ring-2 aperture:ring-background",
              files.request === undefined
                ? "aperture:bg-destructive"
                : "aperture:animate-pulse aperture:bg-amber-500",
            )}
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        sheet
        onSheetDismiss={() => onOpenChange(false)}
        finalFocus={() => typed.current ?? true}
        data-workbench-phone-menu=""
      >
        <DropdownMenuGroup className="aperture:flex aperture:shrink-0 aperture:gap-2 aperture:pb-2">
          {features.navigation ? (
            <>
              <DropdownMenuItem
                className={QUICK}
                data-phone-menu-forward=""
                disabled={!goes || watched?.goesForward !== true}
                onClick={() => session.go({ along: "forward" })}
              >
                <ArrowRight />
                Forward
              </DropdownMenuItem>
              <DropdownMenuItem
                className={QUICK}
                data-phone-menu-reload=""
                disabled={!goes}
                onClick={() => session.go({ along: "reload" })}
              >
                <RefreshCw />
                Reload
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem
            className={QUICK}
            data-phone-menu-copy-url=""
            disabled={watched === undefined}
            onClick={() => {
              if (watched !== undefined) {
                copyTextHere(session, watched.url, "URL copied");
              }
            }}
          >
            <Link2 />
            Copy URL
          </DropdownMenuItem>
          {features.tabs ? (
            <DropdownMenuItem
              className={QUICK}
              data-phone-menu-new-tab=""
              disabled={!changes}
              onClick={() => session.newTab()}
            >
              <Plus />
              New tab
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <WorkbenchMenuSlot name="menu.phone" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Brings up the phone's keyboard for the session, and puts the bar out of its way. */
export function PhoneTypeItem() {
  const session = useSession();
  const { gives } = useInputState();
  const { typed, hideBar } = usePhoneMenu();
  return (
    <DropdownMenuItem
      disabled={!gives}
      data-workbench-keyboard=""
      onClick={(event) => {
        const workbench = event.currentTarget.ownerDocument.querySelector("[data-workbench-phone]");
        typed.current =
          workbench?.querySelector<HTMLElement>("[data-aperture-surface=keys]") ?? null;
        // Within the tap: a phone's keyboard comes for nothing later.
        session.focus();
        hideBar();
      }}
    >
      <Keyboard />
      Type into the session
    </DropdownMenuItem>
  );
}

/** What is copied out of the session and pasted into it. */
export function PhoneClipboardItem() {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-phone-menu-page="clipboard">
        <ClipboardList />
        Clipboard
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <CopyItem />
        <PasteItem />
        <SelectAllItem />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function PhoneDrawItem() {
  const { features, drawing, setDrawing } = useWorkbench();
  const members = useSessionSnapshot().presence?.members.length ?? 0;

  // Nobody to draw for but oneself.
  if (!features.presence || (members < 2 && !drawing)) {
    return null;
  }
  return (
    <DropdownMenuItem data-workbench-draw="" onClick={() => setDrawing(!drawing)}>
      <Pencil />
      {drawing ? "Stop drawing" : "Draw over the page for the others"}
    </DropdownMenuItem>
  );
}

export function PhoneFilesItem() {
  const { features } = useWorkbench();
  const { files } = usePhoneMenu();

  if (!features.files) {
    return null;
  }
  return (
    <DropdownMenuItem data-session-files-button="" onClick={() => files.setOpen(true)}>
      <FolderOpen />
      {files.label}
    </DropdownMenuItem>
  );
}

export function PhoneRecordingItem() {
  const { features, recordings } = useWorkbench();
  const active = recordings.recordings.some(recordingRuns);

  if (!features.recordings) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-phone-menu-page="recording">
        <Circle
          fill={active ? "currentColor" : "none"}
          className={active ? "aperture:text-destructive" : undefined}
        />
        Recording
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <WorkbenchMenuSlot name="menu.recording" />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** How the session is shown here: the bar, the picture, the sound and the theme. */
export function PhoneViewItem() {
  const { slim, setSlim } = usePhoneMenu();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-phone-menu-page="view">
        <Eye />
        View
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuCheckboxItem
          data-phone-menu-slim=""
          checked={slim}
          closeOnClick={false}
          onCheckedChange={setSlim}
        >
          <ChevronsDownUp />
          <Described title="Compact bar">A slim bar that covers less of the page.</Described>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-phone-menu-page="picture">
            <Monitor />
            Picture and viewport
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <WorkbenchMenuSlot name="menu.picture" />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <MuteItem />
        <AppearanceItem />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
