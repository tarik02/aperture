import { useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";

/** A toolbar button that opens a menu, with its name as a tooltip. */
export function MenuButton({
  label,
  variant = "ghost",
  children,
  ...props
}: {
  label: string;
  variant?: ComponentProps<typeof Button>["variant"];
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, "children" | "variant">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant={variant}
                size="icon-sm"
                aria-label={label}
                {...props}
              />
            }
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A submenu's trigger that names a setting and shows what it is set to. */
export function SettingSubTrigger({
  name,
  value,
  disabled,
}: {
  name: string;
  value: ReactNode;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuSubTrigger disabled={disabled}>
      <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-between aperture:gap-3">
        <span className="aperture:shrink-0">{name}</span>
        <span className="aperture:truncate aperture:text-muted-foreground">{value}</span>
      </span>
    </DropdownMenuSubTrigger>
  );
}

/** A menu item's two lines: what it is, and what that means. */
export function Described({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
      <span>{title}</span>
      <span className="aperture:text-xs aperture:text-muted-foreground">{children}</span>
    </span>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.ceil(bytes / 1024)} kB`;
  }
  return `${bytes} B`;
}

export function formatDuration(milliseconds: number): string {
  const elapsed = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatStarted(startedAtMs: number): string {
  return new Date(startedAtMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The small picture of a list's entry, and what stands for it where there is none. */
export function Thumbnail({
  src,
  className,
  children,
}: {
  src: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "aperture:flex aperture:h-9 aperture:w-16 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:overflow-hidden aperture:rounded aperture:bg-muted aperture:text-muted-foreground aperture:ring-1 aperture:ring-foreground/10",
        className,
      )}
    >
      {src === undefined || failed ? (
        children
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="aperture:size-full aperture:object-cover aperture:object-top"
        />
      )}
    </span>
  );
}
