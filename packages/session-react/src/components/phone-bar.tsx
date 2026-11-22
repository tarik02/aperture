import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  Keyboard,
  MoreHorizontal,
  Pencil,
  X,
} from "lucide-react";
import type { Member, Presence } from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@aperture-browser/ui/components/sheet";
import { cn } from "@aperture-browser/ui/utils";
import { useInputState } from "../hooks/use-actions.ts";
import { useAddress } from "../hooks/use-address.ts";
import { recordingRuns } from "../hooks/use-recordings.ts";
import { useSession, useSessionSnapshot, useWatchedTarget } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchMenuSlot, WorkbenchSlot } from "../workbench/slot.tsx";
import { CompactContext } from "./browser-toolbar.tsx";
import { BrowserViewport } from "./browser-viewport.tsx";
import { KeptGallery } from "./kept-gallery.tsx";
import { PageMenu } from "./page-menu.tsx";
import { useSessionFiles } from "./session-files.tsx";
import { automationName, MemberAvatar } from "./session-presence.tsx";
import { hostOf, TabSwitcher } from "./tab-switcher.tsx";

/** How long the on-screen keyboard takes to be gone once what was typed into is left. */
const KEYBOARD_LEAVES_MS = 400;

const ROLES = { view: "may watch", control: "may give input", admin: "admin" } as const;

/** What is pressed in the bar: round, and as large as a finger needs. */
const PRESSED = "aperture:size-10 aperture:shrink-0 aperture:rounded-full";

/**
 * The workbench on a phone: the picture, and below it one bar with the way back and
 * forward, the address, the tabs and a menu with all the rest.
 *
 * The bar stands below the picture and not over it, and stays: a page has its own things
 * at its foot, which a bar over it would cover, and a bar that came and went as the page
 * scrolls would give the page another size each time, which a session's page is drawn
 * anew for.
 */
export function PhoneWorkbench() {
  const { features } = useWorkbench();
  const stage = useRef<HTMLDivElement>(null);
  // The height the picture keeps while the address is typed: the keyboard that comes for
  // it covers the picture's foot, and is no reason to give the page another size.
  const [kept, setKept] = useState<number>();
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(leaving.current), []);

  const editing = (now: boolean) => {
    clearTimeout(leaving.current);
    if (now) {
      setKept(stage.current?.clientHeight);
    } else {
      leaving.current = setTimeout(() => setKept(undefined), KEYBOARD_LEAVES_MS);
    }
  };

  return (
    <div
      data-workbench-phone=""
      className="aperture:relative aperture:flex aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden"
    >
      <div
        ref={stage}
        className="aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col"
        style={kept === undefined ? undefined : { flex: "none", height: kept }}
      >
        <BrowserViewport />
      </div>
      <PhoneBar over={kept !== undefined} onEditing={editing} />
      {features.pageMenu ? <PageMenu /> : null}
      {features.recordings ? <KeptGallery /> : null}
    </div>
  );
}

function PhoneBar({
  over,
  onEditing,
}: {
  /** The bar stands over the picture's foot, which keeps its height meanwhile. */
  over: boolean;
  onEditing: (editing: boolean) => void;
}) {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { features, drawing, setDrawing } = useWorkbench();
  const input = useInputState();
  const watched = useWatchedTarget();
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [people, setPeople] = useState(false);
  const goes = input.changes && watched !== undefined;
  const open = snapshot.connection.state === "open";

  const edit = (now: boolean) => {
    setEditing(now);
    onEditing(now);
  };

  return (
    <CompactContext.Provider value>
      <div
        data-workbench-phone-bar=""
        data-editing={editing ? "" : undefined}
        className={cn(
          "aperture:z-30 aperture:shrink-0 aperture:bg-muted/40 aperture:px-2 aperture:py-1.5",
          over && "aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:bg-transparent",
        )}
      >
        <div className="aperture:flex aperture:h-12 aperture:min-w-0 aperture:items-center aperture:gap-0.5 aperture:rounded-full aperture:bg-background aperture:px-1 aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10">
          {editing ? (
            <AddressField onDone={() => edit(false)} />
          ) : (
            <>
              <WorkbenchSlot name="toolbar.start" />
              {features.navigation ? (
                <>
                  <BarButton
                    label="Back"
                    disabled={!goes || watched?.goesBack !== true}
                    onClick={() => session.go({ along: "back" })}
                  >
                    <ArrowLeft />
                  </BarButton>
                  <BarButton
                    label="Forward"
                    disabled={!goes || watched?.goesForward !== true}
                    onClick={() => session.go({ along: "forward" })}
                  >
                    <ArrowRight />
                  </BarButton>
                </>
              ) : null}
              {features.addressBar ? (
                <AddressButton onEdit={() => edit(true)} />
              ) : (
                <div className="aperture:min-w-0 aperture:flex-1" />
              )}
              {drawing ? (
                <BarButton
                  label="Stop drawing"
                  variant="secondary"
                  aria-pressed
                  onClick={() => setDrawing(false)}
                >
                  <Pencil />
                </BarButton>
              ) : null}
              {features.presence && open ? <PeopleButton onOpen={() => setPeople(true)} /> : null}
              <WorkbenchSlot name="toolbar.end" />
              {features.tabs ? (
                <BarButton
                  label={`Tabs: ${snapshot.targets.length}`}
                  data-workbench-tabs=""
                  onClick={() => setSwitching(true)}
                >
                  <span className="aperture:flex aperture:size-5.5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:border-[1.5px] aperture:border-current aperture:text-[0.6875rem] aperture:leading-none aperture:font-semibold aperture:tabular-nums">
                    {snapshot.targets.length > 99 ? ":)" : snapshot.targets.length}
                  </span>
                </BarButton>
              ) : null}
              {features.menus ? <MoreMenu /> : null}
            </>
          )}
        </div>
      </div>
      {features.tabs ? <TabSwitcher open={switching} onOpenChange={setSwitching} /> : null}
      {features.presence ? <PeopleSheet open={people} onOpenChange={setPeople} /> : null}
    </CompactContext.Provider>
  );
}

function BarButton({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & Omit<
  React.ComponentProps<typeof Button>,
  "children" | "aria-label"
>) {
  return (
    <Button type="button" variant="ghost" aria-label={label} className={PRESSED} {...props}>
      {children}
    </Button>
  );
}

/** Where the watched tab's page is from, which is pressed to say where it is to go. */
function AddressButton({ onEdit }: { onEdit: () => void }) {
  const address = useAddress();
  const watched = useWatchedTarget();
  const connecting = useSessionSnapshot().connection.state === "connecting";
  const shown = watched === undefined ? "" : hostOf(watched.url);

  return (
    <button
      type="button"
      aria-label="Address"
      data-workbench-address-button=""
      disabled={!address.navigates}
      className="aperture:flex aperture:h-10 aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-muted/60 aperture:px-3 aperture:text-sm aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
      onClick={onEdit}
    >
      <span className="aperture:truncate">
        {connecting ? "Connecting…" : shown === "" ? "Search or type an address" : shown}
      </span>
    </button>
  );
}

/** The address as a field, across the bar, for as long as it is typed into. */
function AddressField({ onDone }: { onDone: () => void }) {
  const address = useAddress();
  const field = useRef<HTMLInputElement>(null);

  // Within the tap that asked for it: a phone's keyboard comes for nothing later.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const leave = () => {
    address.reset();
    onDone();
  };

  return (
    <>
      <input
        ref={field}
        data-workbench-address=""
        aria-label="Address"
        value={address.value}
        onChange={(event) => address.type(event.target.value)}
        onBlur={leave}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (address.submit(event.currentTarget.value)) {
              event.currentTarget.blur();
            }
          }
          if (event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
        placeholder="Search or type an address"
        inputMode="url"
        enterKeyHint="go"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        // A phone zooms into a field whose text is smaller than this.
        className="aperture:h-10 aperture:min-w-0 aperture:flex-1 aperture:rounded-full aperture:bg-muted/60 aperture:px-4 aperture:text-base aperture:outline-none"
      />
      <BarButton
        label="Cancel"
        // Before the field is left, which the press would otherwise be too late for.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => field.current?.blur()}
      >
        <X />
      </BarButton>
    </>
  );
}

/** The others in the session, as far as there is room; pressed, everyone. */
function PeopleButton({ onOpen }: { onOpen: () => void }) {
  const { presence } = useSessionSnapshot();
  const others = presence?.members.filter((member) => member.id !== presence.you) ?? [];
  if (presence === undefined || others.length === 0) {
    return null;
  }
  const holds = (member: Member) => presence.held.some((held) => held.holder === member.id);
  const first = others.toSorted((left, right) => Number(holds(right)) - Number(holds(left)));
  const [shown] = first;
  const more = others.length - 1;

  return (
    <button
      type="button"
      data-session-presence=""
      aria-label={`${others.length + 1} people in the session`}
      className="aperture:flex aperture:h-10 aperture:min-w-10 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:gap-0.5 aperture:rounded-full aperture:px-1 aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
      onClick={onOpen}
    >
      {shown === undefined ? null : <MemberAvatar member={shown} holds={holds(shown)} />}
      {more > 0 ? (
        <span className="aperture:text-xs aperture:font-medium aperture:text-muted-foreground aperture:tabular-nums">
          +{more}
        </span>
      ) : null}
    </button>
  );
}

/** Everyone in the session: what each may do, watches and holds, and following them. */
function PeopleSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  const { presence } = useSessionSnapshot();
  // Who was there stays while the sheet closes.
  const last = useRef<Presence | undefined>(presence);
  if (presence !== undefined) {
    last.current = presence;
  }
  const told = presence ?? last.current;
  const you = told?.members.find((member) => member.id === told.you);
  const members = (told?.members ?? []).toSorted(
    (left, right) => Number(right.id === told?.you) - Number(left.id === told?.you),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-workbench-people=""
        className="aperture:max-h-[calc(100dvh-env(safe-area-inset-top)-3rem)] aperture:gap-0 aperture:rounded-t-2xl aperture:pr-[env(safe-area-inset-right)] aperture:pb-[max(0.5rem,env(safe-area-inset-bottom))] aperture:pl-[env(safe-area-inset-left)]"
      >
        <SheetHeader>
          <SheetTitle>In the session</SheetTitle>
          <SheetDescription className="aperture:sr-only">
            Who is in the session, and what each watches and holds.
          </SheetDescription>
        </SheetHeader>
        <ul className="aperture:flex aperture:min-h-0 aperture:flex-col aperture:overflow-y-auto aperture:px-2">
          {members.map((member) => {
            const held = told?.held.filter((one) => one.holder === member.id) ?? [];
            const followed = you?.follows === member.id;
            const said = [
              member.agent
                ? "automation"
                : member.role === undefined
                  ? undefined
                  : ROLES[member.role],
              member.tab === undefined ? undefined : `watches tab ${member.tab}`,
              held.length === 0 ? undefined : `holds tab ${held.map((one) => one.tab).join(", ")}`,
            ].filter((part) => part !== undefined);
            return (
              <li
                key={member.id}
                data-member={member.id}
                className="aperture:flex aperture:min-h-14 aperture:items-center aperture:gap-3 aperture:px-2"
              >
                <MemberAvatar member={member} holds={held.length > 0} />
                <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col">
                  <span className="aperture:truncate aperture:text-sm aperture:font-medium">
                    {member.agent ? automationName(member) : member.name}
                    {member.id === told?.you ? " (you)" : ""}
                  </span>
                  <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                    {said.join(" · ")}
                  </span>
                </span>
                {member.id === told?.you ? null : (
                  <Button
                    type="button"
                    variant={followed ? "secondary" : "outline"}
                    aria-pressed={followed}
                    data-member-follow={member.id}
                    onClick={() => session.follow(followed ? undefined : member.id)}
                  >
                    {followed ? "Following" : "Follow"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Everything the workbench does that has no place in the bar: what the toolbar's buttons
 * do on a wider window, and the browser's menu.
 */
function MoreMenu() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { features, recordings, drawing, setDrawing } = useWorkbench();
  const { gives } = useInputState();
  const files = useSessionFiles();
  const members = snapshot.presence?.members.length ?? 0;
  const recording = recordings.recordings.some(recordingRuns);
  // Where the keyboard goes once the menu has closed: to the session where that was asked
  // for, which the menu would otherwise take back for its button.
  const typed = useRef<HTMLElement | null>(null);

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            typed.current = null;
          }
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              aria-label="Menu"
              data-workbench-menu=""
              className={cn(PRESSED, "aperture:relative")}
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
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={8}
          finalFocus={() => typed.current ?? true}
          className="aperture:w-64"
        >
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={!gives}
              data-workbench-keyboard=""
              onClick={(event) => {
                const workbench =
                  event.currentTarget.ownerDocument.querySelector("[data-workbench-phone]");
                typed.current =
                  workbench?.querySelector<HTMLElement>("[data-aperture-surface=keys]") ?? null;
                // Within the tap: a phone's keyboard comes for nothing later.
                session.focus();
              }}
            >
              <Keyboard />
              Type into the session
            </DropdownMenuItem>
            {features.files ? (
              <DropdownMenuItem data-session-files-button="" onClick={() => files.setOpen(true)}>
                <FolderOpen />
                {files.label}
              </DropdownMenuItem>
            ) : null}
            {features.presence && (members > 1 || drawing) ? (
              <DropdownMenuItem data-workbench-draw="" onClick={() => setDrawing(!drawing)}>
                <Pencil />
                {drawing ? "Stop drawing" : "Draw over the page for the others"}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          <div className="aperture:-mx-1 aperture:my-1 aperture:h-px aperture:bg-border" />
          <WorkbenchMenuSlot name="menu.browser" />
        </DropdownMenuContent>
      </DropdownMenu>
      {features.files ? (
        <Sheet open={files.open} onOpenChange={files.setOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            data-session-files=""
            className="aperture:gap-0 aperture:rounded-t-2xl aperture:pr-[env(safe-area-inset-right)] aperture:pb-[env(safe-area-inset-bottom)] aperture:pl-[env(safe-area-inset-left)]"
          >
            <SheetTitle className="aperture:sr-only">Files</SheetTitle>
            <SheetDescription className="aperture:sr-only">
              What was put into the session, and what its browser downloaded.
            </SheetDescription>
            {files.panel}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
