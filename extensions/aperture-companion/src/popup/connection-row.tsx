import { Button } from "@aperture/ui/components/button";
import { cn } from "@aperture/ui/utils";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { GripVerticalIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../connection.ts";
import type { DropPlacement } from "./use-popup.ts";

const connectionDragKind = "aperture-connection";

interface ConnectionDragData extends Record<string, unknown> {
  kind: typeof connectionDragKind;
  connectionId: string;
}

export function connectionLabel(connection: Connection): string {
  return `${connection.tenantName} · ${new URL(connection.origin).host}`;
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
  onReorder: (sourceId: string, destinationId: string, placement: DropPlacement) => Promise<void>;
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
  const [dropPlacement, setDropPlacement] = useState<DropPlacement | null>(null);
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
    <div className="flex flex-col gap-1">
      <div
        ref={rowRef}
        className={cn("relative flex items-center gap-1", dragging && "opacity-60")}
      >
        <span
          className={cn(
            "pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-primary opacity-0",
            dropPlacement === "before" && "opacity-100",
          )}
        />
        <span
          className={cn(
            "pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-primary opacity-0",
            dropPlacement === "after" && "opacity-100",
          )}
        />
        <Button
          ref={dragHandleRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="cursor-grab touch-none active:cursor-grabbing"
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
          className="min-w-0 flex-1 justify-start"
          disabled={disabled}
          onClick={() => onSelect(connection.id)}
        >
          <span className="truncate">{label}</span>
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
          className="flex items-center justify-between gap-2 px-2 py-1"
        >
          <p className="truncate text-xs text-muted-foreground">Remove this connection?</p>
          <div className="flex gap-1">
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

function dropPlacementFromClientY(element: Element, clientY: number): DropPlacement {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}
