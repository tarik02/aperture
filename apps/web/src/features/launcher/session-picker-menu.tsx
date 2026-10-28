import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { SearchIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { Session } from "@aperture-browser/api-client";
import { Badge } from "@aperture-browser/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { SessionThumbnail } from "#/features/launcher/session-thumbnail.tsx";
import { sessionThumbnailUrl } from "#/features/session/session-display.ts";

type SessionPickerProps = {
  /** Sessions a snapshot can be saved from, in display order. */
  sessions: readonly Session[];
  titleOf: (session: Session) => string;
  onPick: (session: Session) => void;
};

/** A searchable session list in a dropdown, opened by `trigger`. */
export function SessionPickerMenu({
  trigger,
  ...props
}: SessionPickerProps & { trigger: ReactElement; children?: ReactNode }) {
  return (
    <MenuPrimitive.FilterProvider autoHighlight>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align="end" className="aperture:w-auto aperture:p-0">
          <SessionPickerBody {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </MenuPrimitive.FilterProvider>
  );
}

/** The same list as a submenu of another menu. */
export function SessionPickerSubmenu({
  label,
  ...props
}: SessionPickerProps & { label: ReactNode }) {
  return (
    <MenuPrimitive.FilterProvider autoHighlight>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="aperture:w-auto aperture:p-0">
          <SessionPickerBody {...props} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </MenuPrimitive.FilterProvider>
  );
}

function SessionPickerBody({ sessions, titleOf, onPick }: SessionPickerProps) {
  return (
    <div className="aperture:grid aperture:w-80 aperture:max-w-[calc(100vw-2rem)]">
      <div className="aperture:flex aperture:h-9 aperture:items-center aperture:gap-2 aperture:border-b aperture:px-2">
        <SearchIcon className="aperture:size-4 aperture:text-muted-foreground" />
        <MenuPrimitive.Input
          placeholder="Search sessions"
          aria-label="Search sessions"
          className="aperture:h-full aperture:min-w-0 aperture:flex-1 aperture:bg-transparent aperture:text-sm aperture:outline-none"
        />
      </div>
      <MenuPrimitive.List className="aperture:max-h-72 aperture:overflow-y-auto aperture:p-1">
        {sessions.map((session) => {
          const title = titleOf(session);
          return (
            <DropdownMenuItem
              key={session.id}
              label={`${title} ${session.baseSnapshotName ?? ""} ${session.id}`}
              onClick={() => onPick(session)}
              className="aperture:gap-2.5"
            >
              <span className="aperture:relative aperture:aspect-video aperture:w-14 aperture:shrink-0 aperture:overflow-hidden aperture:rounded aperture:ring-1 aperture:ring-foreground/10">
                <SessionThumbnail src={sessionThumbnailUrl(session)} />
              </span>
              <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
                <span className="aperture:truncate">{title}</span>
                <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                  {session.baseSnapshotName ? `from ${session.baseSnapshotName}` : "No snapshot"}
                </span>
              </span>
              <Badge variant={session.status === "running" ? "default" : "outline"}>
                {session.status}
              </Badge>
            </DropdownMenuItem>
          );
        })}
      </MenuPrimitive.List>
      <MenuPrimitive.Empty className="aperture:px-3 aperture:py-6 aperture:text-center aperture:text-sm aperture:text-muted-foreground aperture:empty:hidden">
        {sessions.length === 0 ? "No running or suspended sessions." : "No sessions match."}
      </MenuPrimitive.Empty>
    </div>
  );
}
