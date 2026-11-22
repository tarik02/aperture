import { useEffect, useRef, useState } from "react";
import { Globe2, Paperclip, Plus, Volume2, VolumeX, X } from "lucide-react";
import type { Member, Presence, Target } from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import {
  createHoverCardHandle,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  type HoverCardHandle,
} from "@aperture-browser/ui/components/hover-card";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import { useInputState, useTabSound } from "../hooks/use-actions.ts";
import { recordingRuns } from "../hooks/use-recordings.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchMenuSlot } from "../workbench/slot.tsx";
import { MemberDot } from "./session-presence.tsx";

const VISIBLE_WATCHERS = 3;

/** One tab per target. Tabs keep the order the session tells them in: it has no other. */
export function BrowserTabStrip() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { features, recordings, targetFaviconUrl } = useWorkbench();
  const { open, changes } = useInputState();
  const showPresence = features.presence;
  const recordingTabs = new Set(
    recordings.recordings.filter(recordingRuns).map((recording) => recording.tab),
  );
  const [previewHandle] = useState(() => createHoverCardHandle<number>());
  const { targets, presence } = snapshot;

  const closePreview = () => {
    if (previewHandle.isOpen) {
      previewHandle.close();
    }
  };

  if (targets.length === 0) {
    return (
      <div
        data-browser-tab-strip=""
        className="aperture:flex aperture:h-8 aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-2 aperture:px-2 aperture:text-xs aperture:text-muted-foreground"
      >
        <span>No tabs</span>
        <NewTabButton disabled={!changes} onCreate={() => session.newTab()} />
      </div>
    );
  }

  return (
    <>
      <ScrollArea
        data-browser-tab-strip=""
        scrollbars="horizontal"
        // A finger moves the tabs themselves: a bar over them would only cover them.
        className="aperture:h-8 aperture:min-w-0 aperture:flex-1 aperture:pointer-coarse:h-10 aperture:pointer-coarse:[&>[data-slot=scroll-area-scrollbar]]:hidden"
      >
        <div
          data-browser-tab-strip-tabs=""
          // Under a finger a tab is as tall as the strip: nothing of it is too small to press.
          className="aperture:flex aperture:min-w-max aperture:items-end aperture:gap-0.5 aperture:px-1 aperture:pt-1 aperture:pointer-coarse:pt-0"
        >
          {targets.map((target) => (
            <BrowserTab
              key={target.tab}
              target={target}
              active={target.tab === snapshot.selected}
              recording={recordingTabs.has(target.tab)}
              asksForFiles={snapshot.fileRequests.some((request) => request.tab === target.tab)}
              presence={showPresence ? presence : undefined}
              faviconSrc={targetFaviconUrl(target)}
              disabled={!open}
              changes={changes}
              previewHandle={previewHandle}
              onPreviewClose={closePreview}
            />
          ))}
          <NewTabButton disabled={!changes} onCreate={() => session.newTab()} />
        </div>
      </ScrollArea>
      <HoverCard handle={previewHandle}>
        {({ payload }) => {
          const target = targets.find((current) => current.tab === payload);
          // The watched tab is in full view already.
          if (target === undefined || target.tab === snapshot.selected) {
            return null;
          }
          return <TabPreview target={target} />;
        }}
      </HoverCard>
    </>
  );
}

function BrowserTab({
  target,
  active,
  recording,
  asksForFiles,
  presence,
  faviconSrc,
  disabled,
  changes,
  previewHandle,
  onPreviewClose,
}: {
  target: Target;
  active: boolean;
  recording: boolean;
  asksForFiles: boolean;
  presence: Presence | undefined;
  faviconSrc: string | undefined;
  disabled: boolean;
  /** This member may open and close tabs. */
  changes: boolean;
  previewHandle: HoverCardHandle<number>;
  onPreviewClose: () => void;
}) {
  const session = useSession();
  const tabRef = useRef<HTMLDivElement>(null);
  const held = presence?.held.find((one) => one.tab === target.tab);

  // The watched tab is in sight, also when it was selected elsewhere or the strip is narrow.
  useEffect(() => {
    if (active) {
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);
  const watchers =
    presence?.members.filter(
      (member) =>
        member.id !== presence.you && (member.tab === target.tab || member.id === held?.holder),
    ) ?? [];
  // Someone asks this member for the tab: the tab says so too, also while another is watched.
  const askedOfYou = held?.holder === presence?.you && held?.askedBy !== undefined;

  const tab = (
    <div
      ref={tabRef}
      data-browser-tab=""
      data-tab={target.tab}
      data-active={active ? "" : undefined}
      className={cn(
        "aperture:group aperture:relative aperture:flex aperture:h-7 aperture:pointer-coarse:h-10 aperture:w-52 aperture:max-w-[38vw] aperture:min-w-28 aperture:items-center aperture:gap-1.5 aperture:rounded-t-lg aperture:border aperture:border-b-0 aperture:px-2 aperture:text-left aperture:text-xs aperture:transition-[background-color,border-color,color] aperture:select-none",
        active
          ? "aperture:border-border aperture:bg-background aperture:text-foreground"
          : "aperture:border-transparent aperture:bg-muted/55 aperture:text-muted-foreground aperture:hover:bg-muted",
      )}
      onMouseDown={(event) => {
        // A middle click closes the tab and does not start the browser's scrolling.
        if (event.button === 1) {
          event.preventDefault();
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && changes) {
          event.preventDefault();
          session.closeTab(target.tab);
        }
      }}
    />
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <HoverCardTrigger
            handle={previewHandle}
            payload={target.tab}
            delay={0}
            // Long enough to reach the next tab, which then takes the preview over.
            closeDelay={80}
            render={tab}
          />
        }
      >
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          disabled={disabled}
          className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-1.5 aperture:self-stretch aperture:text-left aperture:outline-none"
          onClick={() => {
            onPreviewClose();
            session.select(target.tab);
          }}
        >
          <TabFavicon src={faviconSrc} />
          {recording ? (
            <>
              <span
                aria-hidden
                className="aperture:size-2 aperture:shrink-0 aperture:animate-pulse aperture:rounded-full aperture:bg-destructive"
              />
              <span className="aperture:sr-only">Being recorded</span>
            </>
          ) : null}
          {asksForFiles ? (
            <>
              <Paperclip
                aria-hidden
                className="aperture:size-3.5 aperture:shrink-0 aperture:text-amber-600 aperture:dark:text-amber-400"
              />
              <span className="aperture:sr-only">Asks for files</span>
            </>
          ) : null}
          <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">
            {tabLabel(target)}
          </span>
        </button>
        {askedOfYou ? (
          <span
            title="Someone asks you for this tab"
            className="aperture:size-2 aperture:shrink-0 aperture:animate-pulse aperture:rounded-full aperture:bg-amber-500"
          />
        ) : null}
        <TabSoundButton target={target} />
        {watchers.length > 0 ? <TabWatchers watchers={watchers} holder={held?.holder} /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // Small among the tabs, and pressed around it as well where a finger points.
          data-touch-dense=""
          className="aperture:relative aperture:-mr-1 aperture:size-5 aperture:shrink-0 aperture:opacity-55 aperture:group-hover:opacity-100 aperture:hover:opacity-100 aperture:pointer-coarse:opacity-100 aperture:pointer-coarse:after:absolute aperture:pointer-coarse:after:-inset-2.5"
          aria-label="Close tab"
          disabled={!changes}
          onClick={() => session.closeTab(target.tab)}
        >
          <X />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent className="aperture:min-w-48">
        <WorkbenchMenuSlot name="menu.tab" kind="context" target={target} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TabWatchers({
  watchers,
  holder,
}: {
  watchers: readonly Member[];
  holder: number | undefined;
}) {
  // The holder first: who drives the tab matters more than who watches it.
  const ordered = watchers.toSorted(
    (left, right) => Number(right.id === holder) - Number(left.id === holder),
  );
  const visible = ordered.slice(0, VISIBLE_WATCHERS);
  const overflow = ordered.length - visible.length;

  return (
    <span
      data-browser-tab-watchers=""
      className="aperture:flex aperture:shrink-0 aperture:-space-x-1"
    >
      {visible.map((member) => (
        <MemberDot key={member.id} member={member} holds={member.id === holder} />
      ))}
      {overflow > 0 ? (
        <span className="aperture:flex aperture:h-4 aperture:items-center aperture:rounded-full aperture:bg-muted aperture:px-1 aperture:text-[0.5rem] aperture:ring-1 aperture:ring-background">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

function NewTabButton({ disabled, onCreate }: { disabled: boolean; onCreate: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="aperture:mb-px aperture:shrink-0"
            aria-label="New tab"
            disabled={disabled}
            onClick={onCreate}
          />
        }
      >
        <Plus />
      </TooltipTrigger>
      <TooltipContent side="bottom">New tab</TooltipContent>
    </Tooltip>
  );
}

export function TabFavicon({ src }: { src: string | undefined }) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);

  if (src === undefined || failedSrc === src) {
    return (
      <Globe2 className="aperture:size-3.5 aperture:shrink-0 aperture:text-muted-foreground" />
    );
  }

  return (
    <img
      src={src}
      alt=""
      className="aperture:size-4 aperture:shrink-0"
      onError={() => setFailedSrc(src)}
    />
  );
}

export function tabLabel(target: Target): string {
  return target.title.trim() === "" ? simplifyUrl(target.url) : target.title;
}

function simplifyUrl(url: string): string {
  if (url === "" || url === "about:blank") {
    return "about:blank";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Tells that a tab sounds, and mutes it for this client; shown for a muted tab too. */
function TabSoundButton({ target }: { target: Target }) {
  const { features } = useWorkbench();
  const sound = useTabSound(target);

  if (!features.sound || (!sound.sounds && !sound.muted)) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="aperture:size-5 aperture:shrink-0"
      aria-label={sound.muted ? "Unmute tab" : "Mute tab"}
      aria-pressed={sound.muted}
      data-browser-tab-sound={sound.muted ? "muted" : "sounds"}
      onClick={sound.toggle}
    >
      {sound.muted ? <VolumeX /> : <Volume2 />}
    </Button>
  );
}

/** How wide a tab's preview is asked for: twice the popup's width, for sharp screens. */
const PREVIEW_WIDTH = 640;

/** The preview each tab was last shown with, which is there at once the next time. */
const lastPreviews = new Map<number, string>();

/**
 * A tab's preview. One popup serves every tab: it fades in for the first one the pointer
 * is over, and moves along to the next.
 */
function TabPreview({ target }: { target: Target }) {
  // The popup is put in its place when it opens, and moves only from there on: a move
  // from where it was before it had a place is not one to show.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPlaced(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <HoverCardContent
      data-browser-tab-preview=""
      align="start"
      sideOffset={8}
      collisionPadding={16}
      positionerClassName={cn(
        "aperture:pointer-events-none",
        placed &&
          "aperture:transition-[top,left,right,bottom,transform] aperture:duration-200 aperture:ease-out",
      )}
      className="aperture:pointer-events-none aperture:flex aperture:w-80 aperture:max-w-[calc(100vw-2rem)] aperture:flex-col aperture:gap-2 aperture:p-2 aperture:transition-opacity aperture:duration-150 aperture:data-ending-style:opacity-0 aperture:data-starting-style:opacity-0"
    >
      <TabPreviewPicture key={target.tab} target={target} />
      <span className="aperture:truncate aperture:text-xs aperture:font-medium">
        {tabLabel(target)}
      </span>
      <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
        {target.url || "about:blank"}
      </span>
    </HoverCardContent>
  );
}

function TabPreviewPicture({ target }: { target: Target }) {
  const session = useSession();
  // Made when the tab's preview shows, so it is the page as it is then and not a picture
  // the browser kept.
  const [src] = useState(() => {
    const url = new URL(session.screenshotUrl(target.tab, PREVIEW_WIDTH));
    url.searchParams.set("at", String(Date.now()));
    return url.toString();
  });
  const [before] = useState(() => lastPreviews.get(target.tab));
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className="aperture:aspect-video aperture:w-full aperture:overflow-hidden aperture:rounded-md aperture:bg-muted aperture:bg-cover aperture:bg-top"
      // What the tab looked like the last time, until it is known what it looks like now.
      style={before === undefined ? undefined : { backgroundImage: `url("${before}")` }}
    >
      <img
        src={src}
        alt=""
        onLoad={() => {
          lastPreviews.set(target.tab, src);
          setLoaded(true);
        }}
        className={cn(
          "aperture:size-full aperture:object-cover aperture:object-top aperture:transition-opacity aperture:duration-150",
          loaded ? "aperture:opacity-100" : "aperture:opacity-0",
        )}
      />
    </div>
  );
}
