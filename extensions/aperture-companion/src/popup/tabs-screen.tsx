import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { cn } from "@aperture-browser/ui/utils";
import { ArrowLeftIcon, Globe2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusAlert } from "./status.tsx";
import { tabUrlLabel } from "./tabs.ts";
import type { Popup } from "./use-popup.ts";

/** Picks which tabs to teleport alongside the current one. */
export function TabsScreen({ popup }: { popup: Popup }) {
  const { draft, busy, actions } = popup;

  return (
    <>
      <header className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back"
          title="Back"
          disabled={busy}
          onClick={actions.closeTabPicker}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-base font-semibold">Select tabs</h1>
      </header>
      <FieldSet className="min-h-0 min-w-0 flex-1 gap-3">
        <ScrollArea
          scrollbars="vertical"
          className="-mx-3 -my-2 min-h-0 w-[calc(100%+1.5rem)] min-w-0 flex-1"
        >
          <div className="flex min-w-0 flex-col gap-3 pt-2">
            {popup.browserWindows.map((browserWindow) => (
              <FieldSet
                key={browserWindow.id}
                className="w-full min-w-0 max-w-full gap-1 overflow-hidden"
              >
                <FieldLegend
                  variant="label"
                  className="mb-0 w-full max-w-full truncate px-3 pb-1 text-xs text-muted-foreground"
                >
                  {browserWindow.label}
                </FieldLegend>
                <FieldGroup
                  data-slot="checkbox-group"
                  className="min-w-0 data-[slot=checkbox-group]:gap-0"
                >
                  {browserWindow.tabs.map((tab) =>
                    tab.id === undefined ? null : (
                      <TabRow
                        key={tab.id}
                        tab={tab}
                        tabId={tab.id}
                        selected={draft.draftTabIds.includes(tab.id)}
                        active={draft.draftTabIds[0] === tab.id}
                        busy={busy}
                        selectionLocked={tab.id === popup.currentTab?.id}
                        onToggle={actions.toggleDraftTab}
                        onActivate={actions.activateDraftTab}
                      />
                    ),
                  )}
                </FieldGroup>
              </FieldSet>
            ))}
          </div>
        </ScrollArea>
        <StatusAlert status={popup.status} />
        <Button
          type="button"
          disabled={busy || draft.draftTabIds.length === 0}
          onClick={actions.confirmTabs}
        >
          Confirm
        </Button>
      </FieldSet>
    </>
  );
}

interface TabRowProps {
  tab: chrome.tabs.Tab;
  tabId: number;
  selected: boolean;
  active: boolean;
  busy: boolean;
  selectionLocked: boolean;
  onToggle: (tabId: number, checked: boolean) => void;
  onActivate: (tabId: number) => void;
}

function TabRow({
  tab,
  tabId,
  selected,
  active,
  busy,
  selectionLocked,
  onToggle,
  onActivate,
}: TabRowProps) {
  const inputId = `tab-${tabId}`;

  return (
    <Field
      orientation="horizontal"
      className={cn(
        "min-w-0 items-center px-3 py-1 transition-colors hover:bg-muted/50",
        selected && "bg-muted",
      )}
    >
      <Checkbox
        id={inputId}
        checked={selected}
        disabled={busy || selectionLocked}
        onCheckedChange={(checked) => onToggle(tabId, checked)}
      />
      <FieldLabel htmlFor={inputId} className="min-w-0 items-center gap-2">
        <TabFavicon tab={tab} />
        <span className="flex min-w-0 flex-1 flex-col gap-0">
          <span className="truncate">{tab.title?.trim() || tab.url || "Untitled tab"}</span>
          <span className="truncate font-mono text-xs leading-tight font-normal text-muted-foreground">
            {tabUrlLabel(tab.url)}
          </span>
        </span>
      </FieldLabel>
      <Button
        type="button"
        variant={active ? "secondary" : "ghost"}
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy || !selected || active}
        aria-pressed={active}
        onClick={() => onActivate(tabId)}
      >
        {active ? "Opens first" : "Open first"}
      </Button>
    </Field>
  );
}

function TabFavicon({ tab }: { tab: chrome.tabs.Tab }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [tab.favIconUrl]);

  if (!tab.favIconUrl || failed) {
    return <Globe2Icon className="size-4 shrink-0 text-muted-foreground" />;
  }

  return (
    <img
      src={tab.favIconUrl}
      alt=""
      className="size-4 shrink-0 rounded-sm"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
