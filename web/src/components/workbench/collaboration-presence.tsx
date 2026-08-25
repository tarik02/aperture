import { Eye, Radio } from "lucide-react";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "#/components/ui/avatar.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "#/components/ui/popover.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import type {
  CollaborationControl,
  CollaborationParticipant,
} from "#/hooks/use-collaboration-control.ts";
import { cn } from "#/lib/utils.ts";

const visibleParticipantCount = 3;

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
    <div className="flex shrink-0 items-center gap-0.5 px-1" aria-label="Session participants">
      {visible.map((participant) => (
        <ParticipantButton
          key={participant.clientId}
          participant={participant}
          collaboration={collaboration}
          compact
        />
      ))}
      {overflow > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                aria-label={`${overflow} more participants`}
              />
            }
          >
            +{overflow}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 gap-1.5">
            <PopoverTitle className="px-1 pb-1 text-xs text-muted-foreground">
              Everyone in this session
            </PopoverTitle>
            {participants.map((participant) => (
              <ParticipantButton
                key={participant.clientId}
                participant={participant}
                collaboration={collaboration}
              />
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function ParticipantButton({
  participant,
  collaboration,
  compact = false,
}: {
  participant: CollaborationParticipant;
  collaboration: CollaborationControl;
  compact?: boolean;
}) {
  const local = participant.clientId === collaboration.clientId;
  const following = participant.clientId === collaboration.followingClientId;
  const label = local
    ? `${participant.name} (you)`
    : following
      ? `Stop following ${participant.name}`
      : `Follow ${participant.name}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={following ? "secondary" : "ghost"}
            size="sm"
            className={cn(
              "h-7 min-w-0 gap-1.5 px-1.5 text-xs",
              compact ? "max-w-32" : "w-full justify-start",
            )}
            disabled={local}
            aria-label={label}
            aria-pressed={following}
            onClick={() => collaboration.follow(following ? null : participant.clientId)}
          />
        }
      >
        <ParticipantAvatar participant={participant} />
        <span className="min-w-0 truncate">{participant.name}</span>
        {following ? <Eye className="size-3 shrink-0" /> : null}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {participant.activeTargetId ? " · active tab available" : ""}
      </TooltipContent>
    </Tooltip>
  );
}

function ParticipantAvatar({ participant }: { participant: CollaborationParticipant }) {
  return (
    <Avatar size="sm" className="shrink-0">
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
