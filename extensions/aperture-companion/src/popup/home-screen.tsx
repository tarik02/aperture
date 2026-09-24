import { Button } from "@aperture/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@aperture/ui/components/field";
import { ScrollArea } from "@aperture/ui/components/scroll-area";
import { Spinner } from "@aperture/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@aperture/ui/components/toggle-group";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import type { Connection } from "../connection.ts";
import { ConnectionMenu } from "./connection-menu.tsx";
import { StatusAlert } from "./status.tsx";
import { selectedTabsLabel } from "./tabs.ts";
import { TeleportOptions } from "./teleport-options.tsx";
import type { Popup } from "./use-popup.ts";

/** The teleport form: which tabs, where to, and the advanced options. */
export function HomeScreen({ popup, connection }: { popup: Popup; connection: Connection }) {
  const { draft, busy, actions } = popup;

  return (
    <>
      <ConnectionMenu popup={popup} connection={connection} />

      <ScrollArea scrollbars="vertical" className="-mx-3 min-h-0 flex-1">
        <FieldGroup className="px-3 pr-4">
          <Field>
            <FieldLabel htmlFor="teleport-tabs">Tabs</FieldLabel>
            <Button
              id="teleport-tabs"
              type="button"
              variant="outline"
              className="w-full min-w-0 justify-between font-normal"
              disabled={busy}
              onClick={actions.openTabPicker}
            >
              <span className="truncate">
                {selectedTabsLabel(popup.selectedTabIds, popup.currentTab, popup.browserWindows)}
              </span>
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </Field>

          <Field>
            <FieldLabel>Destination</FieldLabel>
            <ToggleGroup
              value={[draft.destination]}
              variant="outline"
              spacing={0}
              className="w-full"
              onValueChange={(values) => {
                const value = values[0];
                if (value === "session" || value === "snapshot") {
                  actions.setDestination(value);
                }
              }}
            >
              <ToggleGroupItem className="flex-1" value="session" aria-label="Session">
                Session
              </ToggleGroupItem>
              <ToggleGroupItem
                className="flex-1"
                value="snapshot"
                aria-label="Snapshot"
                disabled={!popup.canCreateSnapshot}
                title={popup.canCreateSnapshot ? undefined : "Requires snapshots:write"}
              >
                Snapshot
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <TeleportOptions popup={popup} connection={connection} />
        </FieldGroup>
      </ScrollArea>

      <StatusAlert status={popup.status} />

      <footer className="mt-auto flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Reset"
          title="Reset"
          disabled={busy}
          onClick={actions.reset}
        >
          <RefreshCwIcon />
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={busy}
          onClick={() => void actions.teleport()}
        >
          {popup.teleporting ? <Spinner data-icon="inline-start" /> : null}
          {popup.teleportLabel}
        </Button>
      </footer>
    </>
  );
}
