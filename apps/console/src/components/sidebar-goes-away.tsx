import { useSidebar } from "@aperture-browser/ui/components/sidebar";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useEffect } from "react";

/** What is open over the page and has an Escape of its own: a menu, a list, a dialog. */
const OWN_ESCAPE = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const POPUP_OPEN = '[data-slot$="-content"][data-open]';

/**
 * The sidebar beside a session is out of the way until it is asked for, and goes again as
 * a sheet does: for Escape, and for a press in the session or anywhere else beside it. A
 * press in what was opened from it, as a menu, is in it; its button is its own to press.
 * Escape that closes it is not the page's.
 */
export function SidebarGoesAway() {
  const { open, setOpen, isMobile } = useSidebar();
  // A narrow window has it as a sheet, which goes by itself.
  const shown = open && !isMobile;

  useHotkey(
    "Escape",
    (event) => {
      if (
        (event.target instanceof Element && event.target.closest(OWN_ESCAPE) !== null) ||
        document.querySelector(POPUP_OPEN) !== null
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    },
    {
      enabled: shown,
      // Before the session's own listener, which would send it to the page.
      capture: true,
      ignoreDefaultPrevented: true,
      // Only where it closes the sidebar: a menu or a dialog open over it has it first.
      preventDefault: false,
      stopPropagation: false,
      // Drawing in the session has Escape as well.
      conflictBehavior: "allow",
    },
  );

  useEffect(() => {
    if (!shown) {
      return undefined;
    }
    const pressed = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="sidebar-inset"]') !== null &&
        target.closest('[data-sidebar="trigger"]') === null
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", pressed, true);
    return () => document.removeEventListener("pointerdown", pressed, true);
  }, [shown, setOpen]);

  return null;
}
