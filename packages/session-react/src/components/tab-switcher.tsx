import { useEffect, useRef, useState } from "react";
import { Plus, Smartphone, X } from "lucide-react";
import type { Presence, Session, Target } from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@aperture-browser/ui/components/sheet";
import { cn } from "@aperture-browser/ui/utils";
import { useInputState } from "../hooks/use-actions.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { TabFavicon, tabLabel } from "./browser-tab-strip.tsx";
import { automationName, MemberDot } from "./session-presence.tsx";

/** How often the picture of a tab that is in view is asked for again. */
const PICTURE_EVERY_MS = 4000;

/** The picture each tab was last shown with, which is there at once the next time. */
const lastPictures = new Map<string, { readonly tag: string | null; readonly url: string }>();

export interface TabSwitcherProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The session's tabs as cards, each with a small picture of its page: the way from one tab
 * to another where there is no room for a row of them.
 */
export function TabSwitcher({ open, onOpenChange }: TabSwitcherProps) {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { features, targetFaviconUrl } = useWorkbench();
  const { changes } = useInputState();
  const { targets, presence } = snapshot;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        data-workbench-tab-switcher=""
        className="aperture:gap-0 aperture:data-[side=bottom]:h-[calc(100dvh-var(--keyboard-inset,0px)-env(safe-area-inset-top)-1.5rem)] aperture:rounded-t-2xl aperture:pr-[env(safe-area-inset-right)] aperture:pb-[env(safe-area-inset-bottom)] aperture:pl-[env(safe-area-inset-left)]"
      >
        <div className="aperture:flex aperture:h-14 aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:pr-2 aperture:pl-4">
          <SheetTitle className="aperture:min-w-0 aperture:flex-1 aperture:truncate">
            {targets.length === 1 ? "1 tab" : `${targets.length} tabs`}
          </SheetTitle>
          <SheetDescription className="aperture:sr-only">
            The session's tabs. Choose one to watch it.
          </SheetDescription>
          <Button
            type="button"
            variant="secondary"
            data-tab-switcher-new=""
            disabled={!changes}
            onClick={() => {
              session.newTab();
              onOpenChange(false);
            }}
          >
            <Plus />
            New tab
          </Button>
          <SheetClose render={<Button type="button" variant="ghost" />}>Done</SheetClose>
        </div>
        <div
          role="list"
          className="aperture:grid aperture:min-h-0 aperture:flex-1 aperture:auto-rows-min aperture:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] aperture:gap-3 aperture:overflow-y-auto aperture:overscroll-contain aperture:px-3 aperture:pt-1 aperture:pb-4"
        >
          {targets.map((target) => (
            <TabCard
              key={target.tab}
              target={target}
              active={target.tab === snapshot.selected}
              presence={features.presence ? presence : undefined}
              faviconSrc={targetFaviconUrl?.(target)}
              closes={changes}
              onSelect={() => {
                session.select(target.tab);
                onOpenChange(false);
              }}
              onClose={() => session.closeTab(target.tab)}
            />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TabCard({
  target,
  active,
  presence,
  faviconSrc,
  closes,
  onSelect,
  onClose,
}: {
  target: Target;
  active: boolean;
  presence: Presence | undefined;
  faviconSrc: string | undefined;
  closes: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const inView = useInView(card);
  const label = tabLabel(target);
  const held = presence?.held.find((one) => one.tab === target.tab);
  const holder = presence?.members.find((member) => member.id === held?.holder);
  const watchers =
    presence?.members.filter((member) => member.tab === target.tab && member.id !== holder?.id) ??
    [];
  const holds =
    holder === undefined
      ? undefined
      : holder.id === presence?.you
        ? "You"
        : holder.agent
          ? automationName(holder)
          : holder.name;

  return (
    <div
      ref={card}
      role="listitem"
      data-tab-card={target.tab}
      data-active={active ? "" : undefined}
      className={cn(
        "aperture:relative aperture:flex aperture:min-w-0 aperture:flex-col aperture:overflow-hidden aperture:rounded-xl aperture:bg-card aperture:ring-1 aperture:ring-foreground/10",
        active && "aperture:ring-2 aperture:ring-primary",
      )}
    >
      <button
        type="button"
        aria-label={`Switch to ${label}`}
        aria-current={active ? "true" : undefined}
        className="aperture:absolute aperture:inset-0 aperture:z-10 aperture:rounded-xl aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
        onClick={onSelect}
      />
      <div className="aperture:flex aperture:h-10 aperture:shrink-0 aperture:items-center aperture:gap-1.5 aperture:pl-2.5">
        <TabFavicon src={faviconSrc} />
        <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:text-xs aperture:font-medium">
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Close ${label}`}
          data-tab-card-close=""
          disabled={!closes}
          className="aperture:relative aperture:z-20 aperture:shrink-0 aperture:text-muted-foreground"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <TabPicture target={target} asked={inView} />
      <div className="aperture:flex aperture:h-8 aperture:shrink-0 aperture:items-center aperture:gap-1.5 aperture:px-2.5 aperture:text-[0.6875rem] aperture:text-muted-foreground">
        {target.mobile ? (
          <Smartphone
            aria-label="Shown as on a phone"
            className="aperture:size-3 aperture:shrink-0"
          />
        ) : null}
        <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">
          {hostOf(target.url)}
        </span>
        {holder === undefined ? null : (
          <span
            data-tab-card-holder=""
            className="aperture:flex aperture:max-w-[60%] aperture:shrink-0 aperture:items-center aperture:gap-1"
          >
            <MemberDot member={holder} holds />
            <span className="aperture:truncate aperture:text-foreground">{holds}</span>
          </span>
        )}
        {watchers.slice(0, 3).map((member) => (
          <MemberDot key={member.id} member={member} holds={false} />
        ))}
      </div>
    </div>
  );
}

/** What a tab's address says of where its page is from. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host === ""
      ? parsed.protocol.replace(/:$/u, "")
      : parsed.host.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

function TabPicture({ target, asked }: { target: Target; asked: boolean }) {
  const session = useSession();
  const src = useTabPicture(session, target, asked);
  return (
    <div className="aperture:aspect-[5/6] aperture:w-full aperture:overflow-hidden aperture:bg-muted">
      {src === undefined ? null : (
        <img
          src={src}
          alt=""
          data-tab-card-picture=""
          className="aperture:size-full aperture:object-cover aperture:object-left-top"
        />
      )}
    </div>
  );
}

/**
 * A tab's small picture, asked for again every while for as long as it is `asked` for.
 * The session makes one in a while and tells when it is the one this browser has already,
 * which then keeps the picture it shows.
 */
function useTabPicture(session: Session, target: Target, asked: boolean): string | undefined {
  // By the target and not by the tab's number: another session's tab may have the number.
  const key = target.id;
  const [src, setSrc] = useState(() => lastPictures.get(key)?.url);
  const tab = target.tab;

  useEffect(() => {
    if (!asked) {
      return undefined;
    }
    let ended = false;
    const look = async () => {
      const answer = await fetch(session.previewUrl(tab), { cache: "no-cache" });
      if (!answer.ok || ended) {
        return;
      }
      const tag = answer.headers.get("etag");
      const before = lastPictures.get(key);
      if (before !== undefined && tag !== null && before.tag === tag) {
        return;
      }
      const url = URL.createObjectURL(await answer.blob());
      if (ended) {
        URL.revokeObjectURL(url);
        return;
      }
      lastPictures.set(key, { tag, url });
      setSrc(url);
      if (before !== undefined) {
        // After the picture that replaces it is shown.
        setTimeout(() => URL.revokeObjectURL(before.url), 1000);
      }
    };
    // A picture that does not come leaves the one there is, or none.
    const again = () => void look().catch(() => undefined);
    again();
    const timer = setInterval(again, PICTURE_EVERY_MS);
    return () => {
      ended = true;
      clearInterval(timer);
    };
  }, [session, tab, key, asked]);

  return src;
}

/** Whether an element is where it can be seen. */
function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return undefined;
    }
    const seen = new IntersectionObserver((entries) => {
      setInView(entries.some((entry) => entry.isIntersecting));
    });
    seen.observe(element);
    return () => seen.disconnect();
  }, [ref]);
  return inView;
}
