import { Radio } from "lucide-react";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "#/components/ui/avatar.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "#/components/ui/popover.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import type {
  CollaborationControl,
  CollaborationParticipant,
} from "#/hooks/use-collaboration-control.ts";
import { cn } from "#/lib/utils.ts";

const visibleParticipantCount = 5;

export function CollaborationPresence({ collaboration }: { collaboration: CollaborationControl }) {
  const participants = [...collaboration.participants].sort((left, right) => {
    if (left.clientId === collaboration.clientId) {
      return -1;
    }
    if (right.clientId === collaboration.clientId) {
      return 1;
    }
    if (left.holdingInput !== right.holdingInput) {
      return left.holdingInput ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const visible = participants.slice(0, visibleParticipantCount);
  const overflow = participants.length - visible.length;

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center -space-x-1.5 px-2" aria-label="Session participants">
      {visible.map((participant) => (
        <ParticipantButton
          key={participant.clientId}
          participant={participant}
          collaboration={collaboration}
        />
      ))}
      {overflow > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 rounded-full border bg-background text-[0.65rem] text-muted-foreground"
                aria-label={`${overflow} more participants`}
              />
            }
          >
            +{overflow}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto gap-2">
            <PopoverTitle className="text-xs text-muted-foreground">Everyone</PopoverTitle>
            <div className="flex flex-wrap items-center gap-1">
              {participants.map((participant) => (
                <ParticipantButton
                  key={participant.clientId}
                  participant={participant}
                  collaboration={collaboration}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function ParticipantButton({
  participant,
  collaboration,
}: {
  participant: CollaborationParticipant;
  collaboration: CollaborationControl;
}) {
  const local = participant.clientId === collaboration.clientId;
  const following = participant.clientId === collaboration.followingClientId;
  const label = local
    ? `${participant.name} (you)`
    : following
      ? `${participant.name} · click to stop following`
      : `${participant.name} · click to follow`;
  const trigger = local ? (
    <span
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full"
      aria-label={label}
    />
  ) : (
    <Button
      type="button"
      variant={following ? "secondary" : "ghost"}
      size="icon-sm"
      className="shrink-0 rounded-full p-0"
      aria-label={label}
      aria-pressed={following}
      onClick={() => collaboration.follow(following ? null : participant.clientId)}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>
        <ParticipantAvatar participant={participant} following={following} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function ParticipantAvatar({
  participant,
  following,
}: {
  participant: CollaborationParticipant;
  following: boolean;
}) {
  return (
    <Avatar size="sm" className={cn("shrink-0 ring-2 ring-background", following && "ring-ring")}>
      <AvatarImage src={gravatarURL(participant.avatarHash)} alt="" />
      <AvatarFallback>{initials(participant.name)}</AvatarFallback>
      {participant.holdingInput ? (
        <AvatarBadge className="bg-emerald-500" title="Has input control">
          <Radio />
        </AvatarBadge>
      ) : null}
    </Avatar>
  );
}

function gravatarURL(hash: string) {
  return `https://www.gravatar.com/avatar/${encodeURIComponent(hash)}?d=identicon&s=64`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
