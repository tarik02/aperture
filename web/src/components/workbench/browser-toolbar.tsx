import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  MousePointer2,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "#/components/ui/input-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { VIEWPORT_PRESETS } from "#/lib/control/viewport.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserTabStrip } from "#/components/workbench/browser-tab-strip.tsx";

type BrowserToolbarProps = {
  control: UseBrowserControlResult;
};

export function BrowserToolbar({ control }: BrowserToolbarProps) {
  const [urlDraft, setUrlDraft] = useState("");

  const displayUrl = control.activeTarget?.url ?? "";
  const busy = control.phase === "connecting";
  const connected = control.phase === "connected";

  function handleNavigate() {
    const nextUrl = urlDraft.trim() || displayUrl;
    if (!nextUrl) {
      return;
    }
    control.navigate(normalizeUrl(nextUrl));
    setUrlDraft("");
  }

  return (
    <div className="flex min-w-0 flex-col gap-1 border-b bg-background">
      <div className="flex items-center gap-0.5 px-1 py-1">
        <ToolbarButton label="Back" disabled={!connected} onClick={() => control.historyBack()}>
          <ArrowLeft />
        </ToolbarButton>
        <ToolbarButton
          label="Forward"
          disabled={!connected}
          onClick={() => control.historyForward()}
        >
          <ArrowRight />
        </ToolbarButton>
        <ToolbarButton label="Reload" disabled={!connected} onClick={() => control.reload()}>
          <RefreshCw />
        </ToolbarButton>
        <ToolbarButton label="Stop" disabled={!connected} onClick={() => control.stopLoading()}>
          <Square />
        </ToolbarButton>
        <ToolbarButton label="Reconnect" disabled={busy} onClick={() => control.reconnect()}>
          <RotateCcw />
        </ToolbarButton>
        <ToolbarButton
          label="New tab"
          disabled={!connected}
          onClick={() => control.createTarget("about:blank")}
        >
          <Plus />
        </ToolbarButton>
        <ToolbarButton
          label="Close tab"
          disabled={!connected || !control.activeTargetId}
          onClick={() => control.activeTargetId && control.closeTarget(control.activeTargetId)}
        >
          <X />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <Select
          value={control.viewport.id}
          onValueChange={(value) => {
            const preset = VIEWPORT_PRESETS.find((item) => item.id === value);
            if (preset) {
              control.setViewport(preset);
            }
          }}
          disabled={!connected}
        >
          <SelectTrigger size="sm" className="h-7 w-[7.5rem] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEWPORT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant={control.captured ? "default" : "outline"}
                size="icon-sm"
                disabled={!connected}
                onClick={() => control.setCaptured(!control.captured)}
              />
            }
          >
            <MousePointer2 />
          </TooltipTrigger>
          <TooltipContent>
            {control.captured ? "Release capture (Esc)" : "Capture input"}
          </TooltipContent>
        </Tooltip>
        {busy ? <Loader2 className="ml-1 size-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <div className="px-1 pb-1">
        <InputGroup>
          <InputGroupInput
            value={urlDraft || displayUrl}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleNavigate();
              }
            }}
            placeholder="URL"
            className="font-mono text-xs"
            disabled={!connected}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="xs" onClick={handleNavigate} disabled={!connected}>
              Go
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <BrowserTabStrip
        targets={control.targets}
        activeTargetId={control.activeTargetId}
        onActivate={control.activateTarget}
        onClose={control.closeTarget}
      />
    </div>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function normalizeUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `https://${value}`;
}
