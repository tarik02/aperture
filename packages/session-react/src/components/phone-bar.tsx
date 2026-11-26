import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Pencil, Search, X } from "lucide-react";
import type { Member, Presence } from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  type DrawerSide,
} from "@aperture-browser/ui/components/drawer";
import { cn } from "@aperture-browser/ui/utils";
import { useInputState } from "../hooks/use-actions.ts";
import { useAddress } from "../hooks/use-address.ts";
import { usePhoneOnSide, useRailSide } from "../hooks/use-media.ts";
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

/** What the bar and what stands for it while it is away are made of: the page shows through. */
const GLASS =
  "aperture:bg-background/75 aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:backdrop-blur-xl aperture:backdrop-saturate-150";

/** How the bar comes and goes. */
const MOVES =
  "aperture:transition-[translate,opacity,scale] aperture:duration-300 aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:motion-reduce:duration-0";

/**
 * Where the bar is laid: across the picture's `foot`, or as a rail along its `left` or
 * `right`, where the phone is held on its side and height is what there is least of.
 */
type BarLay = "foot" | "left" | "right";

/** How much room beside the picture the rail needs to stand there and not over it. */
const RAIL_ROOM = 48;

/** The picture as tall as it is with no keyboard over the window's foot. */
const UNDER_KEYBOARD = "calc(100% + var(--keyboard-inset, 0px))";

/** How far down the page a finger moves it before the bar goes, and how far up before it is back. */
const HIDES_AFTER = 48;
const SHOWS_AFTER = 24;
/** How long a finger rests before what it moved the page by counts anew. */
const DRAG_RESTS_MS = 400;
/** How far a finger goes across the bar before it is a swipe and no press. */
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
 * Tells a swipe across the bar from a press: into the picture and out of it are what the
 * bar does with it, and the press that would follow a swipe is nobody's.
 */
function useSwipe(lay: BarLay, swiped: (inward: boolean) => void, after = SWIPED_PX) {
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
      const [across, along] = lay === "foot" ? [by.y, by.x] : [by.x, by.y];
      if (Math.abs(across) >= after && Math.abs(across) > Math.abs(along)) {
        began.done = true;
        swiped(lay === "left" ? across > 0 : across < 0);
      }
    },
    // A press that ended as none, as one whose finger left the bar, begins no swipe later.
    onPointerUp: () => {
      if (from.current?.done === false) {
        from.current = undefined;
      }
    },
    onPointerCancel: () => {
      from.current = undefined;
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
 * How much room there is beside the workbench at a side of the window: what a screen's
 * cutout and corners keep the picture out of, where whoever shows the workbench leaves
 * that empty.
 */
function useRoomBeside(root: React.RefObject<HTMLElement | null>, lay: BarLay): number {
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null || lay === "foot") {
      setRoom(0);
      return undefined;
    }
    const measure = () => {
      const box = element.getBoundingClientRect();
      const beside = lay === "left" ? box.left : window.innerWidth - box.right;
      setRoom(Math.max(0, Math.round(beside)));
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [root, lay]);
  return room;
}

/**
 * The workbench on a phone: the picture, and over it one bar with the way back, the
 * address, the tabs and a menu with all the rest.
 *
 * The bar is laid over the picture and takes none of its room: the page keeps its size
 * whether the bar is there or away, so nothing of it is drawn anew as the bar comes and
 * goes. It goes as the page is moved down, and a small mark stands for it, which is
 * swiped away where a page has something of its own under it; it is back as the page is
 * moved up or the mark is pressed.
 *
 * A phone held upright has the bar across the picture's foot. One held on its side has a
 * rail along a side of the picture in its place, since height is what there is least of:
 * the address is typed across the picture's head then, and what opens from the rail
 * comes in from its side. Where there is room beside the picture, as a screen's cutout
 * and corners leave, the rail stands there, over nothing, and stays.
 */
export function PhoneWorkbench() {
  const snapshot = useSessionSnapshot();
  const { features, drawing } = useWorkbench();
  const lease = useLease();
  const files = useSessionFiles({ sheet: true });
  const onSide = usePhoneOnSide();
  const railSide = useRailSide();
  const lay: BarLay = onSide ? railSide : "foot";
  const sheetSide = lay === "foot" ? "bottom" : lay;
  const root = useRef<HTMLDivElement>(null);
  const room = useRoomBeside(root, lay);
  const stands = room >= RAIL_ROOM;
  const stage = useRef<HTMLDivElement>(null);
  // The height the picture keeps while the address is typed: the keyboard that comes for
  // it covers the picture's foot, and is no reason to give the page another size.
  const [kept, setKept] = useState<number | string>();
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
    stands ||
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

  // A phone that is turned while the address is typed has another height to keep.
  const turned = useRef(lay);
  useEffect(() => {
    if (turned.current !== lay) {
      turned.current = lay;
      setKept((before) => (before === undefined ? undefined : UNDER_KEYBOARD));
    }
  }, [lay]);

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
    () => ({ typed, hideBar: () => setPlace("away"), files, side: sheetSide }),
    [files, sheetSide, setPlace],
  );

  return (
    <PhoneMenuContext.Provider value={shared}>
      <CompactContext.Provider value>
        <div
          ref={root}
          data-workbench-phone=""
          data-bar={place}
          data-lay={lay}
          className="aperture:relative aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:overflow-hidden"
        >
          <div
            ref={stage}
            className="aperture:absolute aperture:inset-x-0 aperture:top-0 aperture:flex aperture:flex-col aperture:overflow-hidden"
            style={{ height: kept ?? "100%" }}
          >
            <BrowserViewport />
          </div>
          <PhoneBar
            lay={lay}
            beside={stands ? room : 0}
            away={place !== "shown"}
            editing={editing}
            menu={menu}
            onEdit={edit}
            onAway={() => setPlace("away")}
            onSwitching={setSwitching}
            onPeople={setPeople}
            onMenu={setMenu}
          />
          <BarMark
            lay={lay}
            there={place === "away"}
            onShow={() => setPlace("shown")}
            onGone={() => setPlace("gone")}
          />
          {features.pageMenu ? <PageMenu /> : null}
          {features.recordings ? <KeptGallery /> : null}
        </div>
        {features.tabs ? (
          <TabSwitcher side={sheetSide} open={switching} onOpenChange={setSwitching} />
        ) : null}
        {features.presence ? (
          <PeopleSheet side={sheetSide} open={people} onOpenChange={setPeople} />
        ) : null}
        {features.files ? (
          <FilesSheet side={sheetSide} open={files.open} onOpenChange={files.setOpen}>
            {files.panel}
          </FilesSheet>
        ) : null}
      </CompactContext.Provider>
    </PhoneMenuContext.Provider>
  );
}

function PhoneBar({
  lay,
  beside,
  away,
  editing,
  menu,
  onEdit,
  onAway,
  onSwitching,
  onPeople,
  onMenu,
}: {
  lay: BarLay;
  /** The room beside the picture a rail stands in, where it does not stand over it. */
  beside: number;
  away: boolean;
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
  const rail = lay !== "foot" && !editing;
  // Into the picture for the tabs, out of it to put the bar away; neither while the
  // address is typed, nor the latter where the rail stays.
  const swipe = useSwipe(lay, (inward) => {
    if (editing) {
      return;
    }
    if (!inward) {
      if (beside === 0) {
        onAway();
      }
    } else if (features.tabs) {
      onSwitching(true);
    }
  });

  return (
    <div
      data-workbench-phone-bar=""
      data-editing={editing ? "" : undefined}
      data-rail={rail ? lay : undefined}
      data-away={away ? "" : undefined}
      inert={away}
      className={cn(
        "aperture:pointer-events-none aperture:z-30 aperture:flex aperture:justify-center",
        // Beside the picture is outside of what the workbench is laid in, and may be
        // outside of what shows it as well: there the rail is laid by the window.
        rail && beside > 0 ? "aperture:fixed" : "aperture:absolute",
        MOVES,
        !rail &&
          (lay === "foot"
            ? "aperture:inset-x-0 aperture:bottom-0 aperture:px-2 aperture:pb-1.5"
            : // The keyboard is over the window's foot, so the address is typed at its head.
              "aperture:inset-x-0 aperture:top-0 aperture:px-2 aperture:pt-1.5"),
        rail && "aperture:inset-y-0 aperture:items-center aperture:px-1",
        rail && beside === 0 && (lay === "left" ? "aperture:left-0" : "aperture:right-0"),
        away &&
          (lay === "foot"
            ? "aperture:translate-y-[calc(100%+0.5rem)] aperture:opacity-0"
            : lay === "left"
              ? "aperture:-translate-x-[calc(100%+0.5rem)] aperture:opacity-0"
              : "aperture:translate-x-[calc(100%+0.5rem)] aperture:opacity-0"),
      )}
      style={rail && beside > 0 ? { [lay]: 0, width: beside, paddingInline: 0 } : undefined}
    >
      <div
        data-workbench-phone-pill=""
        className={cn(
          "aperture:pointer-events-auto aperture:relative aperture:flex aperture:min-w-0 aperture:touch-none aperture:items-center aperture:gap-0.5 aperture:rounded-full aperture:select-none",
          rail
            ? "aperture:max-h-full aperture:w-12 aperture:flex-col aperture:py-1"
            : "aperture:h-12 aperture:w-full aperture:px-1",
          GLASS,
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
                className={PRESSED}
                disabled={!goes || watched?.goesBack !== true}
                onClick={() => session.go({ along: "back" })}
              >
                <ArrowLeft />
              </BarButton>
            ) : null}
            {features.addressBar ? (
              <AddressButton rail={rail} onEdit={() => onEdit(true)} />
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
            {features.presence && open ? (
              <PeopleButton rail={rail} onOpen={() => onPeople(true)} />
            ) : null}
            <WorkbenchSlot name="toolbar.end" />
            {features.tabs ? (
              <BarButton
                label={`Tabs: ${snapshot.targets.length}`}
                data-workbench-tabs=""
                className={PRESSED}
                onClick={() => onSwitching(true)}
              >
                <span className="aperture:flex aperture:size-5.5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:border-[1.5px] aperture:border-current aperture:text-[0.6875rem] aperture:leading-none aperture:font-semibold aperture:tabular-nums">
                  {snapshot.targets.length > 99 ? ":)" : snapshot.targets.length}
                </span>
              </BarButton>
            ) : null}
            {features.menus ? (
              <PhoneMenu open={menu} onOpenChange={onMenu} className={PRESSED} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What stands for the bar while it is away: where the page is from and who else is here,
 * small, at the middle of the picture's foot; and for a rail a grip with who else is
 * here, at the middle of its side. Pressed or swiped into the picture, the bar is back;
 * swiped out of it, it is gone as well, for a page that has something of its own right
 * there.
 *
 * It is pressed where it is drawn and no further around it, smaller than a finger likes:
 * what it stands over is the page's, and the bar is back by moving the page up as well.
 */
function BarMark({
  lay,
  there,
  onShow,
  onGone,
}: {
  lay: BarLay;
  there: boolean;
  onShow: () => void;
  onGone: () => void;
}) {
  const { features } = useWorkbench();
  const { presence, connection } = useSessionSnapshot();
  const watched = useWatchedTarget();
  // The window ends right beside it: a finger has little way to go out of it.
  const swipe = useSwipe(lay, (inward) => (inward ? onShow() : onGone()), MARK_SWIPED_PX);
  const others =
    features.presence && connection.state === "open"
      ? (presence?.members.filter((member) => member.id !== presence.you) ?? [])
      : [];
  const holds = (member: Member) =>
    presence?.held.some((held) => held.holder === member.id) ?? false;
  const host = watched === undefined ? "" : hostOf(watched.url);
  const foot = lay === "foot";

  return (
    <div
      inert={!there}
      className={cn(
        "aperture:pointer-events-none aperture:absolute aperture:z-30 aperture:flex aperture:justify-center",
        foot
          ? "aperture:inset-x-0 aperture:bottom-0 aperture:pb-0.5"
          : "aperture:inset-y-0 aperture:items-center aperture:px-0.5",
        lay === "left" && "aperture:left-0",
        lay === "right" && "aperture:right-0",
        MOVES,
        !there &&
          (foot
            ? "aperture:translate-y-3 aperture:opacity-0"
            : lay === "left"
              ? "aperture:-translate-x-3 aperture:opacity-0"
              : "aperture:translate-x-3 aperture:opacity-0"),
      )}
    >
      <button
        type="button"
        data-workbench-phone-mark=""
        aria-label="Show the bar"
        className={cn(
          "aperture:pointer-events-auto aperture:flex aperture:touch-none aperture:items-center aperture:justify-center aperture:gap-1 aperture:rounded-full aperture:text-[0.6875rem] aperture:leading-none aperture:font-medium aperture:outline-none aperture:select-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50",
          foot
            ? "aperture:h-6 aperture:max-w-[60%] aperture:min-w-16 aperture:px-2.5"
            : "aperture:min-h-16 aperture:w-5 aperture:flex-col aperture:py-2.5",
          GLASS,
        )}
        onClick={onShow}
        {...swipe}
      >
        {foot ? (
          <span className="aperture:truncate">{host}</span>
        ) : (
          <span
            aria-hidden
            className="aperture:h-6 aperture:w-1 aperture:rounded-full aperture:bg-foreground/40"
          />
        )}
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

/**
 * Where the watched tab's page is from, which is pressed to say where it is to go. A rail
 * has no room to say where the page is from: there it is the way to the address alone.
 */
function AddressButton({ rail, onEdit }: { rail: boolean; onEdit: () => void }) {
  const address = useAddress();
  const watched = useWatchedTarget();
  const connecting = useSessionSnapshot().connection.state === "connecting";
  const shown = watched === undefined ? "" : hostOf(watched.url);

  return (
    <button
      type="button"
      aria-label="Address"
      title={rail ? shown : undefined}
      data-workbench-address-button=""
      disabled={!address.navigates}
      className={cn(
        "aperture:relative aperture:flex aperture:h-10 aperture:min-w-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:opacity-50",
        rail
          ? "aperture:w-10 aperture:shrink-0 aperture:active:bg-accent aperture:[&_svg]:size-4"
          : "aperture:flex-1 aperture:bg-foreground/6 aperture:px-3 aperture:text-sm",
      )}
      onClick={onEdit}
    >
      {rail ? (
        <Search />
      ) : (
        <span className="aperture:truncate">
          {connecting ? "Connecting…" : shown === "" ? "Search or type an address" : shown}
        </span>
      )}
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
function PeopleButton({ rail, onOpen }: { rail: boolean; onOpen: () => void }) {
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
      className={cn(
        "aperture:relative aperture:flex aperture:shrink-0 aperture:items-center aperture:justify-center aperture:gap-0.5 aperture:rounded-full aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50",
        // Under the rail and not in it: the rail's buttons stay where they are as people
        // come and go, so a finger on its way to one does not land on another.
        rail
          ? cn(
              "aperture:absolute aperture:top-full aperture:left-1/2 aperture:mt-1 aperture:min-h-12 aperture:w-12 aperture:-translate-x-1/2 aperture:flex-col aperture:py-1",
              GLASS,
            )
          : "aperture:h-10 aperture:min-w-10 aperture:px-1",
      )}
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
  side,
  open,
  onOpenChange,
}: {
  side: DrawerSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  const { presence } = useSessionSnapshot();
  // Whom one follows goes to other tabs, which a workbench of one tab has none of.
  const follows = useWorkbench().features.tabs;
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
    <Drawer side={side} open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-workbench-people=""
        className={cn(
          "aperture:pb-[max(0.5rem,env(safe-area-inset-bottom))]",
          side === "bottom" &&
            "aperture:max-h-[60%] aperture:pr-[env(safe-area-inset-right)] aperture:pl-[env(safe-area-inset-left)]",
        )}
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
                {member.id === told?.you || !follows ? null : (
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

/** How much of the window's height the files take: as they open, and dragged up. */
const FILES_HEIGHTS = [0.5, 1];

/** The session's files, as a sheet that is dragged like the others. */
function FilesSheet({
  side,
  open,
  onOpenChange,
  children,
}: {
  side: DrawerSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [height, setHeight] = useState<number | string | null>(FILES_HEIGHTS[0] ?? null);
  // Each time it opens it is part of the way up again.
  useEffect(() => {
    if (open) {
      setHeight(FILES_HEIGHTS[0] ?? null);
    }
  }, [open]);
  const snaps = side === "bottom";

  return (
    <Drawer
      side={side}
      open={open}
      onOpenChange={onOpenChange}
      // Its height is this one's to say from the first, also while it has none to be at.
      snapPoint={height}
      onSnapPointChange={setHeight}
      {...(snaps ? { snapPoints: FILES_HEIGHTS } : {})}
    >
      <DrawerContent
        data-session-files=""
        data-height={!snaps || height === FILES_HEIGHTS[1] ? "full" : "part"}
        className={cn(
          side === "bottom"
            ? "aperture:h-full aperture:pr-[env(safe-area-inset-right)] aperture:pl-[env(safe-area-inset-left)]"
            : "aperture:pt-2",
        )}
      >
        <DrawerTitle className="aperture:sr-only">Files</DrawerTitle>
        <DrawerDescription className="aperture:sr-only">
          What was put into the session, and what its browser downloaded.
        </DrawerDescription>
        <DrawerBody className="aperture:pb-[env(safe-area-inset-bottom)]">{children}</DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
