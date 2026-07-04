import { useHotkey } from "@tanstack/react-hotkeys";
import { toast } from "sonner";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserToolbar } from "#/components/workbench/browser-toolbar.tsx";
import { BrowserViewport } from "#/components/workbench/browser-viewport.tsx";

type BrowserControlPaneProps = {
  control: UseBrowserControlResult;
};

export function BrowserControlPane({ control }: BrowserControlPaneProps) {
  useHotkey(
    "Escape",
    () => {
      control.setCaptured(false);
    },
    { enabled: control.captured, preventDefault: true },
  );

  useHotkey(
    "Mod+C",
    () => {
      if (!control.activeTargetId) {
        return;
      }
      control.send({ type: "clipboard.copy", targetId: control.activeTargetId });
    },
    { enabled: control.captured, preventDefault: true },
  );

  useHotkey(
    "Mod+X",
    () => {
      if (!control.activeTargetId) {
        return;
      }
      control.send({ type: "clipboard.cut", targetId: control.activeTargetId });
    },
    { enabled: control.captured, preventDefault: true },
  );

  useHotkey(
    "Mod+V",
    () => {
      void pasteClipboard(control);
    },
    { enabled: control.captured, preventDefault: true },
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BrowserToolbar control={control} />
      <BrowserViewport control={control} viewport={control.viewport} />
    </div>
  );
}

async function pasteClipboard(control: UseBrowserControlResult) {
  if (!control.activeTargetId) {
    return;
  }

  const items: Array<{ mimeType: string; data: string }> = [];

  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      items.push({ mimeType: "text/plain", data: text });
    }
  } catch {
    toast.error("Clipboard read failed");
    return;
  }

  if (items.length === 0) {
    return;
  }

  control.send({
    type: "clipboard.paste",
    targetId: control.activeTargetId,
    items,
  });
}
