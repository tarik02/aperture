import { ContextMenuItem } from "@aperture-browser/ui/components/context-menu";
import { useInputState, useTabSound } from "../hooks/use-actions.ts";
import { copyTextHere } from "../notices.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import type { WorkbenchSlotProps } from "../workbench/contributions.ts";
import { useWorkbench } from "../workbench/context.tsx";

export function TabReloadItem({ target }: WorkbenchSlotProps) {
  const session = useSession();
  const { changes } = useInputState();
  const watched = useSessionSnapshot().selected === target?.id;
  return (
    <ContextMenuItem
      disabled={!changes || !watched}
      onClick={() => session.go({ along: "reload" })}
    >
      Reload
    </ContextMenuItem>
  );
}

export function TabDuplicateItem({ target }: WorkbenchSlotProps) {
  const session = useSession();
  const { changes } = useInputState();
  const url = target?.url ?? "";
  return (
    <ContextMenuItem
      disabled={!changes || url === ""}
      onClick={() => session.go({ url }, { newTab: true })}
    >
      Duplicate
    </ContextMenuItem>
  );
}

export function TabCopyUrlItem({ target }: WorkbenchSlotProps) {
  const session = useSession();
  return (
    <ContextMenuItem
      onClick={() => copyTextHere(session, target?.url || "about:blank", "URL copied")}
    >
      Copy URL
    </ContextMenuItem>
  );
}

/** Mutes the tab for this client, or lets it be heard again. */
export function TabMuteItem({ target }: WorkbenchSlotProps) {
  const { features } = useWorkbench();
  const sound = useTabSound(target);

  if (!features.sound) {
    return null;
  }
  return (
    <ContextMenuItem onClick={sound.toggle}>{sound.muted ? "Unmute" : "Mute"}</ContextMenuItem>
  );
}

export function TabCloseItem({ target }: WorkbenchSlotProps) {
  const session = useSession();
  const { changes } = useInputState();
  return (
    <ContextMenuItem
      disabled={!changes || target === undefined}
      onClick={() => {
        if (target !== undefined) {
          session.closeTab(target.id);
        }
      }}
    >
      Close
    </ContextMenuItem>
  );
}

export function TabCloseOthersItem({ target }: WorkbenchSlotProps) {
  const session = useSession();
  const { changes } = useInputState();
  const others = useSessionSnapshot().targets.filter((other) => other.id !== target?.id);
  return (
    <ContextMenuItem
      disabled={!changes || others.length === 0}
      onClick={() => {
        for (const other of others) {
          session.closeTab(other.id);
        }
      }}
    >
      Close other tabs
    </ContextMenuItem>
  );
}

export function TabCloseRightItem({ target }: WorkbenchSlotProps) {
  const session = useSession();
  const { changes } = useInputState();
  const { targets } = useSessionSnapshot();
  const at = targets.findIndex((other) => other.id === target?.id);
  const toTheRight = at < 0 ? [] : targets.slice(at + 1);
  return (
    <ContextMenuItem
      disabled={!changes || toTheRight.length === 0}
      onClick={() => {
        for (const other of toTheRight) {
          session.closeTab(other.id);
        }
      }}
    >
      Close tabs to the right
    </ContextMenuItem>
  );
}
