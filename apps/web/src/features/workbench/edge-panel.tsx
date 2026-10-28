import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@aperture-browser/ui/utils";

const openDelayMs = 120;
const closeDelayMs = 280;

/**
 * A panel along one edge of the workbench. Pinned, it docks beside the browser; otherwise it
 * slides over the browser while the pointer rests on that edge, and hides again when it leaves.
 */
export function EdgePanel({
  side,
  pinned,
  className,
  children,
}: {
  side: "left" | "right";
  pinned: boolean;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const open = pinned || hoverOpen;

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  function schedule(next: boolean) {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(
      () => {
        timer.current = null;
        setHoverOpen(next);
      },
      next ? openDelayMs : closeDelayMs,
    );
  }

  const close = () => setHoverOpen(false);
  const panelClassName = cn(
    "aperture:flex aperture:w-72 aperture:flex-col aperture:bg-sidebar",
    side === "left" ? "aperture:border-r" : "aperture:border-l",
    className,
  );

  if (pinned) {
    return <aside className={cn(panelClassName, "aperture:shrink-0")}>{children(close)}</aside>;
  }

  return (
    <div
      className={cn(
        "aperture:absolute aperture:inset-y-0 aperture:z-40 aperture:flex",
        side === "left" ? "aperture:left-0" : "aperture:right-0 aperture:flex-row-reverse",
      )}
      onPointerEnter={() => schedule(true)}
      onPointerLeave={() => schedule(false)}
      // Files dragged in from the desktop reveal the panel so they can be dropped on it.
      onDragEnter={() => schedule(true)}
    >
      {/* The hot zone: a few pixels along the edge that reveal the panel on hover. */}
      <div aria-hidden className="aperture:w-1.5" />
      <aside
        aria-hidden={!open}
        inert={!open}
        className={cn(
          panelClassName,
          "aperture:absolute aperture:inset-y-0 aperture:shadow-xl aperture:transition-transform aperture:duration-200 aperture:ease-out",
          side === "left" ? "aperture:left-0" : "aperture:right-0",
          open
            ? "aperture:translate-x-0"
            : side === "left"
              ? "aperture:pointer-events-none aperture:-translate-x-full"
              : "aperture:pointer-events-none aperture:translate-x-full",
        )}
      >
        {children(close)}
      </aside>
    </div>
  );
}

export function loadPinned(key: string) {
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function savePinned(key: string, pinned: boolean) {
  try {
    window.localStorage.setItem(key, String(pinned));
  } catch {
    // The preference lasts for this page when storage is unavailable.
  }
}
