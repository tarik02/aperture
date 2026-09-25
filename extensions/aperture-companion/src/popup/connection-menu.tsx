import { Button } from "@aperture-browser/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@aperture-browser/ui/components/popover";
import { Separator } from "@aperture-browser/ui/components/separator";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { connectionLabel, type Connection } from "../connection.ts";
import { ConnectionRow } from "./connection-row.tsx";
import type { Popup } from "./use-popup.ts";

/** Header of the home screen: the active connection, with a menu to switch and manage them. */
export function ConnectionMenu({ popup, connection }: { popup: Popup; connection: Connection }) {
  const { actions, busy } = popup;
  const [open, setOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  function setMenuOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setPendingRemoval(null);
    }
  }

  async function select(id: string) {
    if (await actions.selectConnection(id)) {
      setMenuOpen(false);
    }
  }

  async function remove(id: string) {
    if (await actions.removeConnection(id)) {
      setPendingRemoval(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setMenuOpen}>
      <header className="flex items-center gap-2">
        <img src="/icon.svg" alt="Aperture" className="size-8 shrink-0" />
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="min-w-0 flex-1 justify-between"
              disabled={busy}
            />
          }
        >
          <span className="truncate">{connectionLabel(connection)}</span>
          {popup.managingConnection ? (
            <Spinner data-icon="inline-end" />
          ) : (
            <ChevronDownIcon data-icon="inline-end" />
          )}
        </PopoverTrigger>
      </header>
      <PopoverContent
        align="start"
        className="max-h-(--available-height) w-(--anchor-width) overflow-y-auto"
      >
        <div className="flex flex-col gap-2">
          {popup.connections.map((candidate) => (
            <ConnectionRow
              key={candidate.id}
              connection={candidate}
              active={candidate.id === connection.id}
              disabled={busy}
              removalPending={pendingRemoval === candidate.id}
              onSelect={(id) => void select(id)}
              onRequestRemoval={setPendingRemoval}
              onCancelRemoval={() => setPendingRemoval(null)}
              onRemove={(id) => void remove(id)}
              onReorder={actions.reorderConnection}
            />
          ))}
          <Separator />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setMenuOpen(false);
              actions.showScreen("add-connection");
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Add connection
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
