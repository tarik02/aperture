import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Pencil, X } from "lucide-react";
import type { Member, Presence } from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@aperture-browser/ui/components/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@aperture-browser/ui/components/sheet";
import { cn } from "@aperture-browser/ui/utils";
import { useInputState } from "../hooks/use-actions.ts";
import { useAddress } from "../hooks/use-address.ts";
import { useShortWindow } from "../hooks/use-media.ts";
import { useStored } from "../hooks/use-stored.ts";
import { useLease, useSession, useSessionSnapshot, useWatchedTarget } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchSlot } from "../workbench/slot.tsx";
import { CompactContext } from "./browser-toolbar.tsx";
import { BrowserViewport } from "./browser-viewport.tsx";
import { KeptGallery } from "./kept-gallery.tsx";
import { PageMenu } from "./page-menu.tsx";
import { PhoneMenu, PhoneMenuContext, type PhoneMenuState } from "./phone-menu.tsx";
import { useSessionFiles } from "./session-files.tsx";
import { automationName, MemberAvatar, MemberDot } from "./session-presence.tsx";
import { hostOf, TabSwitcher } from "./tab-switcher.tsx";

/** How long the on-screen keyboard takes to be gone once what was typed into is left. */
const KEYBOARD_LEAVES_MS = 400;

const ROLES = { view: "may watch", control: "may give input", admin: "admin" } as const;

/** What is pressed in the bar: round, and as large as a finger needs. */
const PRESSED = "aperture:size-10 aperture:shrink-0 aperture:rounded-full";

/** In the slim bar what is pressed is as large, and shows nothing of that around its icon. */
const PRESSED_SLIM =
  "aperture:hover:bg-transparent aperture:active:bg-transparent aperture:aria-expanded:bg-transparent aperture:dark:hover:bg-transparent";

/** What the bar and what stands for it while it is away are made of: the page shows through. */
const GLASS =
  "aperture:bg-background/75 aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:backdrop-blur-xl aperture:backdrop-saturate-150";

/** How the bar comes and goes. */
const MOVES =
  "aperture:transition-[translate,opacity,scale] aperture:duration-300 aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:motion-reduce:duration-0";

const SLIM_KEY = "aperture.session.phone-bar.slim";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** How far down the page a finger moves it before the bar goes, and how far up before it is back. */
const HIDES_AFTER = 48;
const SHOWS_AFTER = 24;
/** How long a finger rests before what it moved the page by counts anew. */
const DRAG_RESTS_MS = 400;
/** How far a finger goes along the bar's short side before it is a swipe and no press. */
const SWIPED_PX = 20;
const MARK_SWIPED_PX = 8;

/** The page a tab shows, as far as another one brings the bar back: not what it scrolled to. */
const pageOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

/**
 * Where the bar is: `shown`; `away`, with a small mark standing for it at the picture's
 * foot; or `gone`, with nothing of it over the page at all.
 */
type BarPlace = "shown" | "away" | "gone";

/**
 * Where the bar is, and the means to put it elsewhere.
 *
 * It goes when a finger moves the page down, and is back when one moves it up, however
 * little the page had left to go: it is the finger that is followed, not the page, so a
 * page that scrolls nowhere brings it back as well. Another page and another tab bring it
 * back, and it is shown for as long as `stays` holds.
 */
function useBarPlace(stays: boolean) {
  const session = useSession();
  const watched = useWatchedTarget();
  const [place, setPlace] = useState<BarPlace>("shown");
  const staying = useRef(stays);
  staying.current = stays;

  useEffect(() => {
    let moved = 0;
    let last = 0;
    return session.onDragged((by) => {
      // Along the page's width is no scrolling of it.
      if (Math.abs(by.y) <= Math.abs(by.x)) {
        return;
      }
      const now = performance.now();
      if (now - last > DRAG_RESTS_MS || Math.sign(by.y) !== Math.sign(moved)) {
        moved = 0;
      }
      last = now;
      moved += by.y;
      if (staying.current) {
        return;
      }
      if (moved > HIDES_AFTER) {
        // What was put out of the way altogether stays so.
        setPlace((before) => (before === "shown" ? "away" : before));
      } else if (moved < -SHOWS_AFTER) {
        setPlace("shown");
      }
    });
  }, [session]);

  const page = watched === undefined ? undefined : `${watched.id} ${pageOf(watched.url)}`;
  useEffect(() => setPlace("shown"), [page]);
  // What it was shown for leaves it shown, and what put it away meanwhile is done.
  useEffect(() => {
    if (stays) {
      setPlace("shown");
    }
  }, [stays]);

  return [stays ? "shown" : place, setPlace] as const;
}

/**
 * Tells a swipe along the bar's short side from a press: up and down are what the bar
 * does with it, and the press that would follow a swipe is nobody's.
 */
function useSwipe(swiped: (up: boolean) => void, after = SWIPED_PX) {
  const from = useRef<{ x: number; y: number; done: boolean } | undefined>(undefined);
  return {
    onPointerDown: (event: React.PointerEvent) => {
      // What is pressed in a sheet opened from here is told here as well, and is no
      // swipe of this.
      const within = event.target instanceof Node && event.currentTarget.contains(event.target);
      from.current = within ? { x: event.clientX, y: event.clientY, done: false } : undefined;
    },
    onPointerMove: (event: React.PointerEvent) => {
      const began = from.current;
      if (began === undefined || began.done) {
        return;
      }
      const by = { x: event.clientX - began.x, y: event.clientY - began.y };
      if (Math.abs(by.y) >= after && Math.abs(by.y) > Math.abs(by.x)) {
        began.done = true;
        swiped(by.y < 0);
      }
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (from.current?.done === true) {
        event.preventDefault();
        event.stopPropagation();
      }
      from.current = undefined;
    },
  };
}

/**
 * The workbench on a phone: the picture, and over its foot one bar with the way back, the
 * address, the tabs and a menu with all the rest.
 *
 * The bar is laid over the picture and takes none of its room: the page keeps its size
 * whether the bar is there or away, so nothing of it is drawn anew as the bar comes and
 * goes. It goes as the page is moved down, and a small mark stands for it at the foot,
 * which is swiped away where a page has something of its own under it; it is back as the
 * page is moved up or the mark is pressed.
 */
export function PhoneWorkbench() {
  const snapshot = useSessionSnapshot();
  const { features, drawing } = useWorkbench();
  const lease = useLease();
  const files = useSessionFiles();
  const short = useShortWindow();
  const [chosenSlim, setSlim] = useStored(SLIM_KEY, false, isBoolean);
  const stage = useRef<HTMLDivElement>(null);
  // The height the picture keeps while the address is typed: the keyboard that comes for
  // it covers the picture's foot, and is no reason to give the page another size.
  const [kept, setKept] = useState<number>();
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(leaving.current), []);
  const [editing, setEditing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [people, setPeople] = useState(false);
  const [menu, setMenu] = useState(false);
  const typed = useRef<HTMLElement | null>(null);

  const watched = snapshot.targets.find((target) => target.tab === snapshot.selected);
  // The bar stays while it is used, while there is no page to move, and while someone
  // asks this member for the tab or a page asks for a file, which the bar tells of.
  const stays =
    editing ||
    switching ||
    people ||
    menu ||
    files.open ||
    files.request !== undefined ||
    drawing ||
    lease.state === "asked-of-you" ||
    snapshot.connection.state !== "open" ||
    watched === undefined;
  const [place, setPlace] = useBarPlace(stays);
  // A phone on its side has the slim bar whatever was chosen: it has the least height.
  const slim = short || chosenSlim;

  const edit = (now: boolean) => {
    clearTimeout(leaving.current);
    setEditing(now);
    if (now) {
      setKept(stage.current?.clientHeight);
    } else {
      leaving.current = setTimeout(() => setKept(undefined), KEYBOARD_LEAVES_MS);
    }
  };

  const shared = useMemo<PhoneMenuState>(
    () => ({ typed, hideBar: () => setPlace("away"), files, slim: chosenSlim, setSlim }),
    [files, chosenSlim, setSlim, setPlace],
  );

  return (
    <PhoneMenuContext.Provider value={shared}>
      <CompactContext.Provider value>
        <div
          data-workbench-phone=""
          data-bar={place}
          className="aperture:relative aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:overflow-hidden"
        >
          <div
            ref={stage}
            className="aperture:absolute aperture:inset-x-0 aperture:top-0 aperture:flex aperture:flex-col"
            style={{ height: kept ?? "100%" }}
          >
            <BrowserViewport />
          </div>
          <PhoneBar
            away={place !== "shown"}
            slim={slim && !editing}
            editing={editing}
            menu={menu}
            onEdit={edit}
            onAway={() => setPlace("away")}
            onSwitching={setSwitching}
            onPeople={setPeople}
            onMenu={setMenu}
          />
          <BarMark
            there={place === "away"}
            onShow={() => setPlace("shown")}
            onGone={() => setPlace("gone")}
          />
          {features.pageMenu ? <PageMenu /> : null}
          {features.recordings ? <KeptGallery /> : null}
        </div>
        {features.tabs ? <TabSwitcher open={switching} onOpenChange={setSwitching} /> : null}
        {features.presence ? <PeopleSheet open={people} onOpenChange={setPeople} /> : null}
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
      </CompactContext.Provider>
    </PhoneMenuContext.Provider>
  );
}

function PhoneBar({
  away,
  slim,
  editing,
  menu,
  onEdit,
  onAway,
  onSwitching,
  onPeople,
  onMenu,
}: {
  away: boolean;
  /** One slim line, as wide as what it holds, in place of the bar across the window. */
  slim: boolean;
  editing: boolean;
  menu: boolean;
  onEdit: (editing: boolean) => void;
  onAway: () => void;
  onSwitching: (switching: boolean) => void;
  onPeople: (open: boolean) => void;
  onMenu: (open: boolean) => void;
}) {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { features, drawing, setDrawing } = useWorkbench();
  const input = useInputState();
  const watched = useWatchedTarget();
  const goes = input.changes && watched !== undefined;
  const open = snapshot.connection.state === "open";
  // Up for the tabs, down to put the bar away; neither while the address is typed.
  const swipe = useSwipe((up) => {
    if (editing) {
      return;
    }
    if (!up) {
      onAway();
    } else if (features.tabs) {
      onSwitching(true);
    }
  });
  const pressed = cn(PRESSED, slim && PRESSED_SLIM);

  return (
    <div
      data-workbench-phone-bar=""
      data-editing={editing ? "" : undefined}
      data-slim={slim ? "" : undefined}
      data-away={away ? "" : undefined}
      inert={away}
      className={cn(
        "aperture:pointer-events-none aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:z-30 aperture:flex aperture:justify-center aperture:px-2",
        slim ? "aperture:pb-0.5" : "aperture:pb-1.5",
        MOVES,
        away && "aperture:translate-y-[calc(100%+0.5rem)] aperture:opacity-0",
      )}
    >
      <div
        data-workbench-phone-pill=""
        className={cn(
          "aperture:pointer-events-auto aperture:relative aperture:flex aperture:min-w-0 aperture:touch-none aperture:items-center aperture:select-none",
          slim
            ? // As tall as a finger needs, and drawn slimmer than that.
              "aperture:isolate aperture:h-10 aperture:max-w-full aperture:gap-1 aperture:px-0.5 aperture:before:absolute aperture:before:inset-x-0 aperture:before:inset-y-1 aperture:before:-z-10 aperture:before:rounded-full aperture:before:content-['']"
            : "aperture:h-12 aperture:w-full aperture:gap-0.5 aperture:rounded-full aperture:px-1",
          slim
            ? "aperture:before:bg-background/75 aperture:before:shadow-lg aperture:before:ring-1 aperture:before:ring-foreground/10 aperture:before:backdrop-blur-xl aperture:before:backdrop-saturate-150"
            : GLASS,
        )}
        {...swipe}
      >
        {editing ? (
          <AddressField onDone={() => onEdit(false)} />
        ) : (
          <>
            <WorkbenchSlot name="toolbar.start" />
            {features.navigation ? (
              <BarButton
                label="Back"
                className={pressed}
                disabled={!goes || watched?.goesBack !== true}
                onClick={() => session.go({ along: "back" })}
              >
                <ArrowLeft />
              </BarButton>
            ) : null}
            {features.addressBar ? (
              <AddressButton slim={slim} onEdit={() => onEdit(true)} />
            ) : (
              <div className="aperture:min-w-0 aperture:flex-1" />
            )}
            {drawing ? (
              <BarButton
                label="Stop drawing"
                variant="secondary"
                aria-pressed
                className={PRESSED}
                onClick={() => setDrawing(false)}
              >
                <Pencil />
              </BarButton>
            ) : null}
            {features.presence && open ? <PeopleButton onOpen={() => onPeople(true)} /> : null}
            <WorkbenchSlot name="toolbar.end" />
            {features.tabs ? (
              <BarButton
                label={`Tabs: ${snapshot.targets.length}`}
                data-workbench-tabs=""
                className={pressed}
                onClick={() => onSwitching(true)}
              >
                <span className="aperture:flex aperture:size-5.5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:border-[1.5px] aperture:border-current aperture:text-[0.6875rem] aperture:leading-none aperture:font-semibold aperture:tabular-nums">
                  {snapshot.targets.length > 99 ? ":)" : snapshot.targets.length}
                </span>
              </BarButton>
            ) : null}
            {features.menus ? (
              <PhoneMenu open={menu} onOpenChange={onMenu} className={pressed} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What stands for the bar while it is away: where the page is from and who else is here,
 * small, at the middle of the picture's foot. Pressed or swiped up, the bar is back;
 * swiped down, it is gone as well, for a page that has something of its own right there.
 *
 * It is pressed where it is drawn and no further around it, smaller than a finger likes:
 * what it stands over is the page's, and the bar is back by moving the page up as well.
 */
function BarMark({
  there,
  onShow,
  onGone,
}: {
  there: boolean;
  onShow: () => void;
  onGone: () => void;
}) {
  const { features } = useWorkbench();
  const { presence, connection } = useSessionSnapshot();
  const watched = useWatchedTarget();
  // The window ends right below it: a finger has little way to go down.
  const swipe = useSwipe((up) => (up ? onShow() : onGone()), MARK_SWIPED_PX);
  const others =
    features.presence && connection.state === "open"
      ? (presence?.members.filter((member) => member.id !== presence.you) ?? [])
      : [];
  const holds = (member: Member) =>
    presence?.held.some((held) => held.holder === member.id) ?? false;
  const host = watched === undefined ? "" : hostOf(watched.url);

  return (
    <div
      inert={!there}
      className={cn(
        "aperture:pointer-events-none aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:z-30 aperture:flex aperture:justify-center aperture:pb-0.5",
        MOVES,
        !there && "aperture:translate-y-3 aperture:opacity-0",
      )}
    >
      <button
        type="button"
        data-workbench-phone-mark=""
        aria-label="Show the bar"
        className={cn(
          "aperture:pointer-events-auto aperture:flex aperture:h-6 aperture:max-w-[60%] aperture:min-w-16 aperture:touch-none aperture:items-center aperture:justify-center aperture:gap-1 aperture:rounded-full aperture:px-2.5 aperture:text-[0.6875rem] aperture:leading-none aperture:font-medium aperture:outline-none aperture:select-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50",
          GLASS,
        )}
        onClick={onShow}
        {...swipe}
      >
        <span className="aperture:truncate">{host}</span>
        {others.slice(0, 3).map((member) => (
          <MemberDot key={member.id} member={member} holds={holds(member)} />
        ))}
      </button>
    </div>
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
    <Button type="button" variant="ghost" aria-label={label} {...props}>
      {children}
    </Button>
  );
}

/** Where the watched tab's page is from, which is pressed to say where it is to go. */
function AddressButton({ slim, onEdit }: { slim: boolean; onEdit: () => void }) {
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
      className={cn(
        "aperture:relative aperture:flex aperture:h-10 aperture:min-w-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50",
        slim
          ? "aperture:max-w-48 aperture:px-1.5 aperture:text-[0.8125rem] aperture:font-medium"
          : "aperture:flex-1 aperture:bg-foreground/6 aperture:px-3 aperture:text-sm",
      )}
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
        className="aperture:h-10 aperture:min-w-0 aperture:flex-1 aperture:rounded-full aperture:bg-foreground/6 aperture:px-4 aperture:text-base aperture:outline-none"
      />
      <BarButton
        label="Cancel"
        className={PRESSED}
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
      className="aperture:relative aperture:flex aperture:h-10 aperture:min-w-10 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:gap-0.5 aperture:rounded-full aperture:px-1 aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
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
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-workbench-people=""
        className="aperture:pr-[env(safe-area-inset-right)] aperture:pb-[max(0.5rem,env(safe-area-inset-bottom))] aperture:pl-[env(safe-area-inset-left)]"
      >
        <div className="aperture:flex aperture:h-13 aperture:shrink-0 aperture:items-center aperture:px-4 aperture:select-none">
          <DrawerTitle>In the session</DrawerTitle>
          <DrawerDescription className="aperture:sr-only">
            Who is in the session, and what each watches and holds.
          </DrawerDescription>
        </div>
        <DrawerBody render={<ul />} className="aperture:flex aperture:flex-col aperture:px-2">
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
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
