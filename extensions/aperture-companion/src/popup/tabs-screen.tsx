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
      <header className="aperture:flex aperture:items-center aperture:gap-2">
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
        <h1 className="aperture:text-base aperture:font-semibold">Select tabs</h1>
      </header>
      <FieldSet className="aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:gap-3">
        <ScrollArea
          scrollbars="vertical"
          className="aperture:-mx-3 aperture:-my-2 aperture:min-h-0 aperture:w-[calc(100%+1.5rem)] aperture:min-w-0 aperture:flex-1"
        >
          <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-3 aperture:pt-2">
            {popup.browserWindows.map((browserWindow) => (
              <FieldSet
                key={browserWindow.id}
                className="aperture:w-full aperture:min-w-0 aperture:max-w-full aperture:gap-1 aperture:overflow-hidden"
              >
                <FieldLegend
                  variant="label"
                  className="aperture:mb-0 aperture:w-full aperture:max-w-full aperture:truncate aperture:px-3 aperture:pb-1 aperture:text-xs aperture:text-muted-foreground"
                >
                  {browserWindow.label}
                </FieldLegend>
                <FieldGroup
                  data-slot="checkbox-group"
                  className="aperture:min-w-0 aperture:data-[slot=checkbox-group]:gap-0"
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
        "aperture:min-w-0 aperture:items-center aperture:px-3 aperture:py-1 aperture:transition-colors aperture:hover:bg-muted/50",
        selected && "aperture:bg-muted",
      )}
    >
      <Checkbox
        id={inputId}
        checked={selected}
        disabled={busy || selectionLocked}
        onCheckedChange={(checked) => onToggle(tabId, checked)}
      />
      <FieldLabel htmlFor={inputId} className="aperture:min-w-0 aperture:items-center aperture:gap-2">
        <TabFavicon tab={tab} />
        <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-0">
          <span className="aperture:truncate">{tab.title?.trim() || tab.url || "Untitled tab"}</span>
          <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:leading-tight aperture:font-normal aperture:text-muted-foreground">
            {tabUrlLabel(tab.url)}
          </span>
        </span>
      </FieldLabel>
      <Button
        type="button"
        variant={active ? "secondary" : "ghost"}
        size="sm"
        className="aperture:h-7 aperture:shrink-0 aperture:px-2 aperture:text-xs"
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
    return <Globe2Icon className="aperture:size-4 aperture:shrink-0 aperture:text-muted-foreground" />;
  }

  return (
    <img
      src={tab.favIconUrl}
      alt=""
      className="aperture:size-4 aperture:shrink-0 aperture:rounded-sm"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
