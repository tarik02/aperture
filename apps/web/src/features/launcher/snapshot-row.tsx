import { format, formatDistanceToNow } from "date-fns";
import { Camera, MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import type { Session, Snapshot } from "@aperture-browser/api-client";
import { SelectionLabel, type ItemSelection } from "#/components/resources/selection-checkbox.tsx";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { cn } from "@aperture-browser/ui/utils";
import { SessionPickerSubmenu } from "#/features/launcher/session-picker-menu.tsx";
import type { SessionActions, SessionPermissions } from "#/features/session/session-dialogs.tsx";

type SnapshotRowProps = {
  snapshot: Snapshot;
  saveableSessions: readonly Session[];
  titleOf: (session: Session) => string;
  actions: SessionActions;
  permissions: SessionPermissions;
  canWriteSnapshots: boolean;
  selection?: ItemSelection;
  wrap?: (row: ReactElement) => ReactElement;
};

export function SnapshotRow({
  snapshot,
  saveableSessions,
  titleOf,
  actions,
  permissions,
  canWriteSnapshots,
  selection,
  wrap,
}: SnapshotRowProps) {
  const deleted = Boolean(snapshot.deletedAt);
  const createdAt = new Date(snapshot.createdAt);

  const row = (
    <div
      className={cn(
        "aperture:group/item aperture:flex aperture:min-w-0 aperture:items-start aperture:gap-3 aperture:rounded-xl aperture:bg-card aperture:px-3 aperture:py-2.5 aperture:ring-1 aperture:ring-foreground/10",
        deleted && "aperture:opacity-70",
        selection?.selected &&
          "aperture:bg-muted/40 aperture:opacity-100 aperture:ring-2 aperture:ring-primary",
      )}
    >
      <div className="aperture:grid aperture:min-w-0 aperture:flex-1 aperture:gap-0.5">
        <div className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-2">
          {selection ? (
            <SelectionLabel
              selection={selection}
              label={`Select ${snapshot.name}`}
              className="aperture:flex-none"
            >
              <span className="aperture:truncate aperture:text-sm aperture:font-medium">
                {snapshot.name}
              </span>
            </SelectionLabel>
          ) : (
            <span className="aperture:truncate aperture:text-sm aperture:font-medium">
              {snapshot.name}
            </span>
          )}
          {deleted ? <Badge variant="outline">deleted</Badge> : null}
        </div>
        <p
          className={cn(
            "aperture:text-sm aperture:text-muted-foreground",
            !snapshot.description && "aperture:italic",
          )}
        >
          {snapshot.description ?? "No description"}
        </p>
        <p className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
          <span title={format(createdAt, "yyyy-MM-dd HH:mm")}>
            Saved {formatDistanceToNow(createdAt, { addSuffix: true })}
          </span>
          {snapshot.promotedFromSession ? (
            <>
              {" "}
              · from session{" "}
              {snapshot.promotedFromSession.name ?? snapshot.promotedFromSession.id.slice(0, 8)}
            </>
          ) : null}
          {snapshot.parentSnapshot ? (
            <>
              {" "}
              · based on {snapshot.parentSnapshot.name ?? snapshot.parentSnapshot.id.slice(0, 8)}
            </>
          ) : null}
        </p>
      </div>
      {!deleted && permissions.canWrite ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => actions.newSession({ baseSnapshot: snapshot.name })}
        >
          Start session
        </Button>
      ) : null}
      {canWriteSnapshots ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${snapshot.name}`}>
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="aperture:min-w-52">
            {deleted ? (
              <DropdownMenuItem onClick={() => actions.restoreSnapshot(snapshot)}>
                <RotateCcw />
                Restore
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onClick={() => actions.editSnapshot(snapshot)}>
                  <Pencil />
                  Edit description
                </DropdownMenuItem>
                {permissions.canSaveSnapshots ? (
                  <SessionPickerSubmenu
                    label={
                      <>
                        <Camera />
                        Update from session
                      </>
                    }
                    sessions={saveableSessions}
                    titleOf={titleOf}
                    onPick={(session) => actions.saveToSnapshot(session, snapshot)}
                  />
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => actions.deleteSnapshot(snapshot)}
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );

  return wrap ? wrap(row) : row;
}
