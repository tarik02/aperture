import { Button } from "@aperture-browser/ui/components/button";
import { cn } from "@aperture-browser/ui/utils";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { GripVerticalIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectionLabel, type Connection, type Placement } from "../connection.ts";

const connectionDragKind = "aperture-connection";

interface ConnectionDragData extends Record<string, unknown> {
  kind: typeof connectionDragKind;
  connectionId: string;
}

interface ConnectionRowProps {
  connection: Connection;
  active: boolean;
  disabled: boolean;
  removalPending: boolean;
  onSelect: (id: string) => void;
  onRequestRemoval: (id: string) => void;
  onCancelRemoval: () => void;
  onRemove: (id: string) => void;
  onReorder: (sourceId: string, destinationId: string, placement: Placement) => Promise<void>;
}

/** A connection in the connection menu: select it, drag it to reorder, or remove it. */
export function ConnectionRow({
  connection,
  active,
  disabled,
  removalPending,
  onSelect,
  onRequestRemoval,
  onCancelRemoval,
  onRemove,
  onReorder,
}: ConnectionRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const dragHandleRef = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropPlacement, setDropPlacement] = useState<Placement | null>(null);
  const label = connectionLabel(connection);

  useEffect(() => {
    const element = rowRef.current;
    const dragHandle = dragHandleRef.current;
    if (element === null || dragHandle === null) {
      return;
    }

    return combine(
      draggable({
        element,
        dragHandle,
        canDrag: () => !disabled,
        getInitialData: () => ({ kind: connectionDragKind, connectionId: connection.id }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) =>
          !disabled &&
          isConnectionDragData(source.data) &&
          source.data.connectionId !== connection.id,
        getData: () => ({ kind: connectionDragKind, connectionId: connection.id }),
        onDrag: ({ location, self }) => {
          setDropPlacement(dropPlacementFromClientY(self.element, location.current.input.clientY));
        },
        onDragEnter: ({ location, self }) => {
          setDropPlacement(dropPlacementFromClientY(self.element, location.current.input.clientY));
        },
        onDragLeave: () => setDropPlacement(null),
        onDrop: ({ source, self, location }) => {
          setDropPlacement(null);
          if (!isConnectionDragData(source.data)) {
            return;
          }
          void onReorder(
            source.data.connectionId,
            connection.id,
            dropPlacementFromClientY(self.element, location.current.input.clientY),
          );
        },
      }),
    );
  }, [connection.id, disabled, onReorder]);

  return (
    <div className="aperture:flex aperture:flex-col aperture:gap-1">
      <div
        ref={rowRef}
        className={cn(
          "aperture:relative aperture:flex aperture:items-center aperture:gap-1",
          dragging && "aperture:opacity-60",
        )}
      >
        <span
          className={cn(
            "aperture:pointer-events-none aperture:absolute aperture:inset-x-1 aperture:top-0 aperture:h-0.5 aperture:rounded-full aperture:bg-primary aperture:opacity-0",
            dropPlacement === "before" && "aperture:opacity-100",
          )}
        />
        <span
          className={cn(
            "aperture:pointer-events-none aperture:absolute aperture:inset-x-1 aperture:bottom-0 aperture:h-0.5 aperture:rounded-full aperture:bg-primary aperture:opacity-0",
            dropPlacement === "after" && "aperture:opacity-100",
          )}
        />
        <Button
          ref={dragHandleRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="aperture:cursor-grab aperture:touch-none aperture:active:cursor-grabbing"
          aria-label={`Reorder ${label}`}
          title="Drag to reorder"
          disabled={disabled}
        >
          <GripVerticalIcon />
        </Button>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="sm"
          className="aperture:min-w-0 aperture:flex-1 aperture:justify-start"
          disabled={disabled}
          onClick={() => onSelect(connection.id)}
        >
          <span className="aperture:truncate">{label}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${label}`}
          title="Remove"
          disabled={disabled}
          onClick={() => onRequestRemoval(connection.id)}
        >
          <Trash2Icon />
        </Button>
      </div>
      {removalPending ? (
        <div
          role="group"
          aria-label={`Confirm removal of ${label}`}
          className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-2 aperture:px-2 aperture:py-1"
        >
          <p className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
            Remove this connection?
          </p>
          <div className="aperture:flex aperture:gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={onCancelRemoval}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              disabled={disabled}
              onClick={() => onRemove(connection.id)}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isConnectionDragData(data: Record<string, unknown>): data is ConnectionDragData {
  return data.kind === connectionDragKind && typeof data.connectionId === "string";
}

function dropPlacementFromClientY(element: Element, clientY: number): Placement {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}
