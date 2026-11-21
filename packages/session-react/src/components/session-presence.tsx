import { useEffect, useState } from "react";
import { Bot, Hand, Hourglass, Radio } from "lucide-react";
import type { Member, Presence } from "@aperture-browser/session-client";
import { Avatar, AvatarBadge, AvatarFallback } from "@aperture-browser/ui/components/avatar";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@aperture-browser/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import { useLease, useSession, useSessionSnapshot } from "../session.tsx";

const VISIBLE_MEMBERS = 5;

/** The session gives a tab to whoever asked when its holder has not answered for this long. */
const ANSWER_WITHIN_SECONDS = 10;

const ROLES = { view: "may watch", control: "may give input", admin: "admin" } as const;

/** Who is in the session, as the old workbench showed its collaborators. */
export function SessionPresence() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { presence } = snapshot;
  if (presence === undefined || presence.members.length === 0) {
    return null;
  }

  const holds = (member: Member) => presence.held.some((held) => held.holder === member.id);
  const members = presence.members.toSorted((left, right) => {
    if (left.id === presence.you) {
      return -1;
    }
    if (right.id === presence.you) {
      return 1;
    }
    if (holds(left) !== holds(right)) {
      return holds(left) ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const visible = members.slice(0, VISIBLE_MEMBERS);
  const overflow = members.length - visible.length;

  const button = (member: Member) => (
    <MemberButton key={member.id} member={member} presence={presence} onFollow={session.follow} />
  );

  return (
    <div
      data-session-presence=""
      className="aperture:group aperture:flex aperture:shrink-0 aperture:items-center aperture:px-2"
      aria-label="Members of the session"
    >
      {overflow > 0 ? (
        <div className="aperture:relative" style={{ zIndex: visible.length + 1 }}>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="aperture:shrink-0 aperture:rounded-full aperture:border aperture:bg-background aperture:text-[0.65rem] aperture:text-muted-foreground"
                  aria-label={`${overflow} more members`}
                />
              }
            >
              +{overflow}
            </PopoverTrigger>
            <PopoverContent align="end" className="aperture:w-auto aperture:gap-2">
              <PopoverTitle className="aperture:text-xs aperture:text-muted-foreground">
                Everyone
              </PopoverTitle>
              <div className="aperture:flex aperture:max-w-64 aperture:flex-wrap aperture:items-center aperture:gap-1">
                {members.map(button)}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
      {visible.map((member, index) => (
        <div
          key={member.id}
          className={cn(
            "aperture:relative aperture:transition-[margin] aperture:duration-200",
            (index > 0 || overflow > 0) &&
              "aperture:-ml-2 aperture:group-focus-within:ml-0 aperture:group-hover:ml-0",
          )}
          style={{ zIndex: visible.length - index }}
        >
          {button(member)}
        </div>
      ))}
    </div>
  );
}

function MemberButton({
  member,
  presence,
  onFollow,
}: {
  member: Member;
  presence: Presence;
  onFollow: (member?: number) => void;
}) {
  const you = member.id === presence.you;
  const followed = presence.members.find((one) => one.id === presence.you)?.follows === member.id;
  const follower = member.follows === presence.you;
  const held = presence.held.filter((one) => one.holder === member.id);

  const details = [
    you ? `${member.name} (you)` : member.name,
    member.agent ? "automation" : member.role === undefined ? undefined : ROLES[member.role],
    member.tab === undefined ? undefined : `watches tab ${member.tab}`,
    held.length === 0 ? undefined : `holds tab ${held.map((one) => one.tab).join(", ")}`,
    follower ? "follows you" : undefined,
    followed ? "you follow them · click to stop" : undefined,
    !you && !followed ? "click to follow them" : undefined,
  ].filter((part) => part !== undefined);
  const label = details.join(" · ");

  const trigger = you ? (
    <span
      className="aperture:inline-flex aperture:size-7 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full"
      aria-label={label}
    />
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        "aperture:shrink-0 aperture:rounded-full aperture:p-0",
        followed && "aperture:ring-2 aperture:ring-primary",
      )}
      aria-label={label}
      aria-pressed={followed}
      data-member-follow={member.id}
      onClick={() => onFollow(followed ? undefined : member.id)}
    />
  );
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>
        <MemberAvatar member={member} holds={held.length > 0} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function MemberAvatar({
  member,
  holds = false,
  className,
}: {
  member: Member;
  /** The member holds the lease of a tab. */
  holds?: boolean;
  className?: string;
}) {
  return (
    <Avatar
      size="sm"
      className={cn("aperture:shrink-0 aperture:ring-2 aperture:ring-background", className)}
    >
      <AvatarFallback
        className="aperture:text-[0.625rem] aperture:font-medium aperture:text-white"
        style={{ backgroundColor: memberColor(member) }}
      >
        {member.agent ? <Bot className="aperture:size-3.5" /> : initials(member.name)}
      </AvatarFallback>
      {holds ? (
        <AvatarBadge
          className="aperture:bg-emerald-500 aperture:group-data-[size=sm]/avatar:size-2.5"
          title="Holds a tab's lease"
        >
          <Radio />
        </AvatarBadge>
      ) : null}
    </Avatar>
  );
}

/** One member, as a mark on the tab they watch. */
export function MemberDot({ member, holds }: { member: Member; holds: boolean }) {
  return (
    <span
      className={cn(
        "aperture:flex aperture:size-4 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:text-[0.5rem] aperture:leading-none aperture:font-semibold aperture:text-white aperture:ring-1 aperture:ring-background",
        holds && "aperture:ring-2 aperture:ring-emerald-500",
      )}
      style={{ backgroundColor: memberColor(member) }}
      title={holds ? `${member.name} holds this tab` : `${member.name} watches this tab`}
    >
      {member.agent ? <Bot className="aperture:size-2.5" /> : initials(member.name).slice(0, 1)}
    </span>
  );
}

/**
 * The lease of the watched tab, where it concerns this member: someone else holds the tab,
 * or someone asks this member for it. Laid over the picture, where input that does not
 * land is noticed.
 */
export function LeaseOverlay() {
  const session = useSession();
  const lease = useLease();
  const { state, holder, asker } = lease;

  if (state === "asked-of-you") {
    return (
      <LeaseRequest
        key={asker?.id}
        asker={asker}
        onAllow={() => session.lease("allow")}
        onKeep={() => session.lease("keep")}
      />
    );
  }

  if (state !== "theirs" && state !== "theirs-asked" && state !== "you-asked") {
    return null;
  }

  const name = holder?.agent ? "Automation" : (holder?.name ?? "Someone");
  // An admin's asking takes the tab, and so does a person's from the automation.
  const takes = lease.role === "admin" || holder?.agent === true;

  return (
    <div
      data-session-lease={state}
      role="status"
      className="aperture:absolute aperture:top-2 aperture:left-1/2 aperture:z-30 aperture:flex aperture:max-w-[calc(100%-1rem)] aperture:-translate-x-1/2 aperture:items-center aperture:gap-2 aperture:rounded-full aperture:border aperture:bg-popover/95 aperture:py-1 aperture:pr-1 aperture:pl-1.5 aperture:text-xs aperture:text-popover-foreground aperture:shadow-md aperture:backdrop-blur"
    >
      {holder === undefined ? null : <MemberAvatar member={holder} holds />}
      <span className="aperture:min-w-0 aperture:truncate">
        <span className="aperture:font-medium">{name}</span> holds this tab
      </span>
      {state === "you-asked" ? (
        <span className="aperture:flex aperture:h-6 aperture:shrink-0 aperture:items-center aperture:gap-1 aperture:rounded-full aperture:bg-muted aperture:px-2 aperture:text-muted-foreground">
          <Hourglass className="aperture:size-3" />
          Asked
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          className="aperture:shrink-0 aperture:rounded-full"
          disabled={state === "theirs-asked" && !takes}
          onClick={() => session.lease("take")}
        >
          <Hand />
          {takes ? "Take the lease" : "Ask for the lease"}
        </Button>
      )}
    </div>
  );
}

function LeaseRequest({
  asker,
  onAllow,
  onKeep,
}: {
  asker: Member | undefined;
  onAllow: () => void;
  onKeep: () => void;
}) {
  const [left, setLeft] = useState(ANSWER_WITHIN_SECONDS);

  useEffect(() => {
    const timer = setInterval(() => setLeft((current) => Math.max(0, current - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      data-session-lease="asked-of-you"
      role="alertdialog"
      aria-label="Someone asks for this tab"
      className="aperture:absolute aperture:top-3 aperture:left-1/2 aperture:z-40 aperture:w-88 aperture:max-w-[calc(100%-1rem)] aperture:-translate-x-1/2 aperture:animate-in aperture:overflow-hidden aperture:rounded-xl aperture:border aperture:border-amber-500/60 aperture:bg-popover aperture:text-popover-foreground aperture:shadow-xl aperture:ring-4 aperture:ring-amber-500/25 aperture:duration-200 aperture:fade-in-0 aperture:slide-in-from-top-4"
    >
      <div className="aperture:flex aperture:items-start aperture:gap-3 aperture:p-3">
        <span className="aperture:relative aperture:flex aperture:shrink-0">
          <span className="aperture:absolute aperture:inset-0 aperture:animate-ping aperture:rounded-full aperture:bg-amber-500/50" />
          {asker === undefined ? (
            <span className="aperture:flex aperture:size-6 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-amber-500 aperture:text-white">
              <Hand className="aperture:size-3.5" />
            </span>
          ) : (
            <MemberAvatar member={asker} className="aperture:ring-amber-500" />
          )}
        </span>
        <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-0.5">
          <span className="aperture:text-sm aperture:font-medium">
            {asker?.name ?? "Someone"} asks for this tab
          </span>
          <span className="aperture:text-xs aperture:text-muted-foreground">
            You hold its lease. It goes to them in{" "}
            <span className="aperture:font-medium aperture:text-foreground aperture:tabular-nums">
              {left} s
            </span>{" "}
            unless you keep it.
          </span>
        </div>
      </div>
      <div className="aperture:flex aperture:items-center aperture:justify-end aperture:gap-2 aperture:border-t aperture:bg-muted/40 aperture:px-3 aperture:py-2">
        <Button type="button" size="sm" variant="outline" onClick={onKeep}>
          Keep
        </Button>
        <Button type="button" size="sm" onClick={onAllow}>
          Allow
        </Button>
      </div>
      <div
        className="aperture:h-0.5 aperture:bg-amber-500 aperture:transition-[width] aperture:duration-1000 aperture:ease-linear"
        style={{ width: `${(left / ANSWER_WITHIN_SECONDS) * 100}%` }}
      />
    </div>
  );
}

// None near the green that marks who holds a lease.
const MEMBER_HUES = [12, 38, 70, 200, 230, 260, 290, 320, 350];

export function memberColor(member: Member): string {
  if (member.agent) {
    return "oklch(0.45 0.02 260)";
  }
  let hash = 0;
  for (const letter of member.name) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 9973;
  }
  return `oklch(0.55 0.15 ${MEMBER_HUES[hash % MEMBER_HUES.length]})`;
}

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? "")
    .join("");
}
